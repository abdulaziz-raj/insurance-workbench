import type { CaptureField, Condition, Rule, RuleTest, TestRunResult } from "@workbench/schema";

export function evaluateCondition(cond: Condition, inputs: Record<string, unknown>): boolean {
  if (cond.all) return cond.all.every((c) => evaluateCondition(c, inputs));
  if (cond.any) return cond.any.some((c) => evaluateCondition(c, inputs));

  // Quantifiers: iterate over an array field and evaluate sub-condition against each item
  if (cond.each) {
    const arr = inputs[cond.each.field];
    if (!Array.isArray(arr) || arr.length === 0) return false;
    return arr.every((item) => evaluateCondition(cond.each!.cond, item as Record<string, unknown>));
  }
  if (cond.some) {
    const arr = inputs[cond.some.field];
    if (!Array.isArray(arr) || arr.length === 0) return false;
    return arr.some((item) => evaluateCondition(cond.some!.cond, item as Record<string, unknown>));
  }

  const { field, op, value } = cond;
  if (!field || !op) return false;
  const actual = inputs[field];
  switch (op) {
    case "eq":     return actual === value || String(actual) === String(value);
    case "neq":    return actual !== value && String(actual) !== String(value);
    case "gt":     return Number(actual) > Number(value);
    case "gte":    return Number(actual) >= Number(value);
    case "lt":
      return (typeof actual === "string" && typeof value === "string")
        ? actual < value : Number(actual) < Number(value);
    case "lte":
      return (typeof actual === "string" && typeof value === "string")
        ? actual <= value : Number(actual) <= Number(value);
    case "in":     return Array.isArray(value) && value.includes(actual);
    case "nin":    return Array.isArray(value) && !value.includes(actual);
    case "exists": return actual !== undefined && actual !== null && actual !== "";
    case "true":   return actual === true || actual === "true" || actual === 1;
    case "false":  return actual === false || actual === "false" || actual === 0;
    default:       return false;
  }
}

export function runTest(rule: Rule, test: RuleTest, index: number): TestRunResult {
  const fired = evaluateCondition(rule.when, test.inputs);
  const actualAction = fired ? rule.then.action : "pass";
  const expectedAction = test.expected.action;
  return { index, pass: actualAction === expectedAction, actualAction, expectedAction, inputs: test.inputs };
}

export function runRuleTests(rule: Rule): TestRunResult[] {
  return rule.tests.map((t, i) => runTest(rule, t, i));
}

// ---- Adaptive eligibility interview ----------------------------------------
// Three-valued evaluation of a condition against the answers gathered so far:
//   "true"    — the condition is satisfied (rule fires)
//   "false"   — the condition can never be satisfied given known answers (rule is dead)
//   "unknown" — the condition could still go either way pending more answers (rule is live)

export type Ternary = "true" | "false" | "unknown";

export function evaluatePartial(cond: Condition, answers: Record<string, unknown>): Ternary {
  if (cond.all) {
    const vs = cond.all.map((c) => evaluatePartial(c, answers));
    if (vs.includes("false")) return "false";
    if (vs.every((v) => v === "true")) return "true";
    return "unknown";
  }
  if (cond.any) {
    const vs = cond.any.map((c) => evaluatePartial(c, answers));
    if (vs.includes("true")) return "true";
    if (vs.every((v) => v === "false")) return "false";
    return "unknown";
  }
  // Array quantifiers: only decidable once the array field has been answered.
  if (cond.each) return cond.each.field in answers ? (evaluateCondition(cond, answers) ? "true" : "false") : "unknown";
  if (cond.some) return cond.some.field in answers ? (evaluateCondition(cond, answers) ? "true" : "false") : "unknown";
  // Leaf
  if (!cond.field) return "false";
  if (!(cond.field in answers)) return "unknown";
  return evaluateCondition(cond, answers) ? "true" : "false";
}

// Leaf field ids in a condition that are still unanswered — the candidate questions.
function unansweredFields(cond: Condition, answers: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (c?: Condition) => {
    if (!c) return;
    if (c.all) c.all.forEach(walk);
    else if (c.any) c.any.forEach(walk);
    else if (c.each) { if (!(c.each.field in answers)) out.push(c.each.field); }
    else if (c.some) { if (!(c.some.field in answers)) out.push(c.some.field); }
    else if (c.field && !(c.field in answers)) out.push(c.field);
  };
  walk(cond);
  return out;
}

export interface InterviewQuestion {
  type: "question";
  field: CaptureField;
  /** ids of the live rules that need this field — for explainability */
  neededBy: string[];
}
export interface InterviewDecision {
  type: "decision";
  outcome: "decline" | "refer" | "eligible" | "manual_review";
  firedRules: { id: string; type: string; action: string; description: string }[];
}
export type InterviewStep = InterviewQuestion | InterviewDecision;

// Rules whose action drives the eligibility decision (knockouts, eligibility, referrals).
function isDecisionRule(r: Rule): boolean {
  return r.type === "knockout" || r.type === "eligibility" || r.then.action === "decline" || r.then.action === "refer";
}

/**
 * Given the approved rules, the capture schema, and the answers collected so far, return either
 * the next decision-relevant question to ask, or the final eligibility decision. Asks only fields
 * that gate a still-undecided ("live") decision rule, knockout-gating fields first, and stops as
 * soon as a knockout fires or no live decision rule remains.
 */
export function interviewStep(
  rules: Rule[],
  schema: CaptureField[],
  answers: Record<string, unknown>,
): InterviewStep {
  const approved = rules.filter((r) => r.status === "approved" || r.status === "draft");
  const fired = approved.filter((r) => evaluatePartial(r.when, answers) === "true");
  const describe = (r: Rule) => ({ id: r.id, type: r.type, action: r.then.action, description: r.description });

  // 1) A fired knockout is terminal — decline immediately.
  const knockout = fired.find((r) => r.type === "knockout" || r.then.action === "decline");
  if (knockout) {
    return { type: "decision", outcome: "decline", firedRules: fired.filter((r) => r.type === "knockout" || r.then.action === "decline").map(describe) };
  }

  // 2) Any decision rule still live? If so, ask the field that unblocks the most live rules
  //    (knockout-gating fields prioritized).
  const decisionRules = approved.filter(isDecisionRule);
  const live = decisionRules.filter((r) => evaluatePartial(r.when, answers) === "unknown");

  if (live.length === 0) {
    // Terminal: no more decision questions. Outcome from what fired.
    const referred = fired.some((r) => r.then.action === "refer");
    return {
      type: "decision",
      outcome: referred ? "refer" : "eligible",
      firedRules: fired.filter((r) => isDecisionRule(r)).map(describe),
    };
  }

  const knockoutFields = new Set(live.filter((r) => r.type === "knockout").flatMap((r) => unansweredFields(r.when, answers)));
  const count = new Map<string, number>();
  const neededBy = new Map<string, string[]>();
  for (const r of live) {
    for (const f of new Set(unansweredFields(r.when, answers))) {
      count.set(f, (count.get(f) ?? 0) + 1);
      neededBy.set(f, [...(neededBy.get(f) ?? []), r.id]);
    }
  }

  let bestField: string | null = null;
  let bestScore = -1;
  for (const [f, c] of count) {
    const score = c + (knockoutFields.has(f) ? 1000 : 0);
    if (score > bestScore) { bestScore = score; bestField = f; }
  }

  if (!bestField) {
    // Live rules exist but reference no askable fields — fall back to manual review.
    return { type: "decision", outcome: "manual_review", firedRules: fired.filter(isDecisionRule).map(describe) };
  }

  const field = schema.find((s) => s.id === bestField)
    ?? schema.flatMap((s) => s.items ?? []).find((s) => s.id === bestField)
    ?? ({ id: bestField, label: bestField, section: "", datatype: "string", required: false, source: { document: "", excerpt: "" } } as CaptureField);

  return { type: "question", field, neededBy: neededBy.get(bestField) ?? [] };
}

// Richer state for a natural, LLM-led interview: the deterministic decision (if reached), the
// rules that have fired, and ALL the info still needed — so the conversational agent can decide
// (with judgment) what to ask next and how to phrase it, while the engine owns the evaluation.
export interface InterviewState {
  status: "question" | "decision";
  outcome?: "decline" | "refer" | "eligible" | "manual_review";
  firedRules: { id: string; type: string; action: string; description: string }[];
  pendingFields: { id: string; label: string; datatype: string; options?: string[] }[];
}

export function interviewState(
  rules: Rule[],
  schema: CaptureField[],
  answers: Record<string, unknown>,
): InterviewState {
  const approved = rules.filter((r) => r.status === "approved" || r.status === "draft");
  const describe = (r: Rule) => ({ id: r.id, type: r.type, action: r.then.action, description: r.description });
  const fired = approved.filter((r) => evaluatePartial(r.when, answers) === "true");

  const knockouts = fired.filter((r) => r.type === "knockout" || r.then.action === "decline");
  if (knockouts.length > 0) {
    return { status: "decision", outcome: "decline", firedRules: knockouts.map(describe), pendingFields: [] };
  }

  const decisionRules = approved.filter(isDecisionRule);
  const live = decisionRules.filter((r) => evaluatePartial(r.when, answers) === "unknown");

  if (live.length === 0) {
    const referred = fired.some((r) => r.then.action === "refer");
    return {
      status: "decision",
      outcome: referred ? "refer" : "eligible",
      firedRules: fired.filter(isDecisionRule).map(describe),
      pendingFields: [],
    };
  }

  const knockoutFields = new Set(live.filter((r) => r.type === "knockout").flatMap((r) => unansweredFields(r.when, answers)));
  const ids = [...new Set(live.flatMap((r) => unansweredFields(r.when, answers)))]
    .sort((a, b) => (knockoutFields.has(b) ? 1 : 0) - (knockoutFields.has(a) ? 1 : 0));

  const lookup = (id: string) =>
    schema.find((s) => s.id === id) ?? schema.flatMap((s) => s.items ?? []).find((s) => s.id === id);
  const pendingFields = ids.map((id) => {
    const f = lookup(id);
    return { id, label: f?.label ?? id, datatype: f?.datatype ?? "string", options: f?.options };
  });

  return { status: "question", firedRules: fired.filter(isDecisionRule).map(describe), pendingFields };
}
