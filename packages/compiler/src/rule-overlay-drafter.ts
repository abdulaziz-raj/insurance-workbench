import OpenAI from "openai";
import type { CaptureField, DocumentEntry, Rule } from "@workbench/schema";

// Compact rule shape the model returns (same as the base drafter's rule item).
const RULE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "snake_case id. To OVERRIDE a base rule, reuse its EXACT id. To ADD, use a new id prefixed with the state, e.g. ca_free_look_senior." },
    type: { type: "string", enum: ["knockout", "eligibility", "disclosure", "validation", "rating_placeholder"] },
    description: { type: "string" },
    inputs: { type: "array", items: { type: "string" } },
    when: {
      type: "object",
      properties: {
        field: { type: "string" }, op: { type: "string" }, value: {},
        all: { type: "array", items: { type: "object" } },
        any: { type: "array", items: { type: "object" } },
        each: { type: "object", properties: { field: { type: "string" }, cond: { type: "object" } }, required: ["field", "cond"] },
        some: { type: "object", properties: { field: { type: "string" }, cond: { type: "object" } }, required: ["field", "cond"] },
      },
    },
    then: { type: "object", properties: { action: { type: "string" }, params: { type: "object" } }, required: ["action"] },
    source: {
      type: "object",
      properties: { document: { type: "string" }, page: { type: "number" }, section: { type: "string" }, excerpt: { type: "string" } },
      required: ["document", "excerpt"],
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    tests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          inputs: { type: "object" },
          expected: { type: "object", properties: { action: { type: "string" }, params: { type: "object" } }, required: ["action"] },
        },
        required: ["inputs", "expected"],
      },
    },
  },
  required: ["id", "type", "description", "inputs", "when", "then", "source", "confidence", "tests"],
};

const OVERLAY_TOOL = {
  type: "function" as const,
  function: {
    name: "draft_overlay",
    description: "Return the state overlay: only the deltas (overrides + additions) and the ids of base rules the state removes.",
    parameters: {
      type: "object",
      properties: {
        rules: { type: "array", items: RULE_ITEM_SCHEMA },
        disabledBaseRuleIds: { type: "array", items: { type: "string" }, description: "base rule ids this state removes/suppresses" },
      },
      required: ["rules", "disabledBaseRuleIds"],
    },
  },
};

function schemaContext(captureSchema: CaptureField[]): string {
  return captureSchema
    .flatMap((f) => {
      const line = `${f.id} | ${f.label} | ${f.datatype}`;
      if (f.datatype === "array" && f.items?.length) {
        return [line, ...f.items.map((sub) => `  ${f.id}[].${sub.id} | ${sub.label} | ${sub.datatype}`)];
      }
      return [line];
    })
    .join("\n");
}

function baseRulesContext(baseRules: Rule[]): string {
  return baseRules
    .map((r) => `- id: ${r.id} | ${r.type} | ${r.description} | when: ${JSON.stringify(r.when)} | then: ${r.then.action}`)
    .join("\n");
}

/**
 * Draft a jurisdiction overlay as DELTAS against an existing base ruleset.
 * Returns only the state's changes: overrides (reusing base rule ids), additions (new ids),
 * and the ids of base rules the state removes.
 */
export async function draftOverlayRules(
  jurisdiction: string,
  baseRules: Rule[],
  baseSchema: CaptureField[],
  guidanceDocs: DocumentEntry[],
): Promise<{ rules: Rule[]; disabledBaseRuleIds: string[] }> {
  const client = new OpenAI();

  let guidanceText = "";
  for (const doc of guidanceDocs) {
    if (!doc.rawText) continue;
    guidanceText += `=== ${doc.name} (${doc.role}) ===\n${doc.rawText}\n\n`;
  }
  if (!guidanceText) guidanceText = "(No state addendum text provided.)";

  const system = `You are an expert insurance underwriting analyst drafting a **${jurisdiction}** STATE OVERLAY on top of an existing countrywide (US) base ruleset.

The base rules already exist (listed below). Your job: from the ${jurisdiction} state addendum, produce ONLY the changes ${jurisdiction} makes to the base — nothing else. The overlay must be small.

Three kinds of change:
1. OVERRIDE — the state modifies an existing base rule: output a rule that REUSES THE BASE RULE'S EXACT id, with the changed condition/action.
2. ADD — the state adds a requirement not in the base: output a rule with a NEW snake_case id prefixed with the state (e.g. ${jurisdiction.toLowerCase()}_free_look_senior).
3. REMOVE — the state suppresses a base rule: put that base rule's exact id in disabledBaseRuleIds (do NOT also output it as a rule).

Rules:
- Do NOT restate base rules the state leaves unchanged. If the addendum doesn't change something, omit it.
- inputs[] reference field ids from the capture schema below (the base schema).
- Ops: eq, neq, gt, gte, lt, lte, in, nin, exists, true, false. Actions: decline, refer, require_disclosure, validate_error, flag_review, rating_placeholder.
- 2–3 tests per rule (a firing case AND a non-firing case). expected.action = "pass" when the condition does NOT fire; otherwise the rule's then.action.
- source.excerpt must be verbatim text from the ${jurisdiction} addendum.
- Do NOT invent thresholds not in the addendum.`;

  const user = `Capture schema (base) — field id | label | datatype:
${schemaContext(baseSchema)}

Existing base rules (countrywide):
${baseRulesContext(baseRules)}

${jurisdiction} state addendum:
${guidanceText}

Produce the ${jurisdiction} overlay deltas only.`;

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 8192,
    temperature: 0.1,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    tools: [OVERLAY_TOOL],
    tool_choice: { type: "function", function: { name: "draft_overlay" } },
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    return { rules: [], disabledBaseRuleIds: [] };
  }
  const parsed = JSON.parse(toolCall.function.arguments) as { rules?: Rule[]; disabledBaseRuleIds?: string[] };

  const baseIds = new Set(baseRules.map((r) => r.id));
  const rules = (parsed.rules ?? []).map((rule) => ({
    ...rule,
    status: "draft" as const,
    testStatus: "untested" as const,
    generatedBy: "gpt-4o",
    // tag whether this delta overrides a base rule or adds a new one (for the reviewer)
    notes: baseIds.has(rule.id) ? `Overrides base rule "${rule.id}"` : `New ${jurisdiction}-specific rule`,
  }));

  // Only keep disabled ids that actually exist in the base.
  const disabledBaseRuleIds = (parsed.disabledBaseRuleIds ?? []).filter((id) => baseIds.has(id));

  return { rules, disabledBaseRuleIds };
}
