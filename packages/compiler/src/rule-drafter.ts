import OpenAI from "openai";
import type { CaptureField, DocumentEntry, Rule } from "@workbench/schema";

const SYSTEM_PROMPT = `You are an expert insurance underwriting rules analyst. Given a capture schema (the fields on an insurance application) and source guidelines documents, draft executable rules.

Rule types to generate:
- knockout: conditions that automatically decline an application (very high bar — only what guidelines explicitly state)
- eligibility: conditions that determine whether coverage can be offered
- disclosure: required notices or documents that must be surfaced to the applicant
- validation: field-level checks (format, range, cross-field logic implied by the form)
- rating_placeholder: mark where pricing/risk classification applies — stub only, DO NOT invent thresholds or premiums

Requirements:
1. Every rule MUST cite the exact passage it was derived from (source.excerpt must be verbatim text from the guidelines).
2. Confidence: "high" = explicitly stated in guidelines, "medium" = clearly implied, "low" = inferred with uncertainty.
3. Generate 2–3 tests per rule with concrete inputs and expected outcomes.
   TEST GENERATION RULE — critical: the engine evaluates whether the rule FIRES or not.
   - If your test inputs SATISFY the condition (rule fires), set expected.action = the rule's then.action.
   - If your test inputs do NOT satisfy the condition (rule does not fire), set expected.action = "pass".
   - "pass" means the rule evaluated and found no issue — it is NOT an action the rule takes.
   - Every rule must have at least one fire test AND at least one no-fire ("pass") test.
4. inputs[] must contain only field IDs that exist in the provided capture schema. Use exact IDs from the schema.
5. Do NOT invent thresholds, numbers, or risk classes beyond what is explicitly written in the provided documents.
6. Conditions use these ops: eq, neq, gt, gte, lt, lte, in, nin, exists, true, false
7. Outcome actions: decline, refer, require_disclosure, validate_error, flag_review, rating_placeholder
8. ARRAY / COPE FIELDS: If the schema contains array fields (e.g. "locations", "buildings"), use quantifiers in the condition:
   - {some:{field:"buildings",cond:{field:"construction_type",op:"in",value:["Frame","Joisted Masonry"]}}} — any building has that type
   - {each:{field:"buildings",cond:{field:"sprinklers",op:"true"}}} — every building has sprinklers
   - inputs[] for such rules should list the array field id (e.g. "buildings").
   - Sub-field ids inside each/some cond are the item-level ids from the schema items[], not the parent-prefixed ids.`;

const RULE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Unique snake_case rule id, e.g. ko_age_term_mismatch" },
    type: { type: "string", enum: ["knockout", "eligibility", "disclosure", "validation", "rating_placeholder"] },
    description: { type: "string" },
    inputs: { type: "array", items: { type: "string" }, description: "CaptureField ids this rule reads" },
    when: {
      type: "object",
      description: "Condition tree. Leaf: {field, op, value}. Compound: {all:[...]} or {any:[...]}. Array quantifiers: {each:{field,cond}} (all items satisfy) or {some:{field,cond}} (any item satisfies).",
      properties: {
        field: { type: "string" },
        op: { type: "string" },
        value: {},
        all: { type: "array", items: { type: "object" } },
        any: { type: "array", items: { type: "object" } },
        each: {
          type: "object",
          description: "ALL items in the named array field satisfy cond.",
          properties: {
            field: { type: "string", description: "The array field id (e.g. 'locations', 'buildings')" },
            cond: { type: "object" },
          },
          required: ["field", "cond"],
        },
        some: {
          type: "object",
          description: "AT LEAST ONE item in the named array field satisfies cond.",
          properties: {
            field: { type: "string", description: "The array field id (e.g. 'locations', 'buildings')" },
            cond: { type: "object" },
          },
          required: ["field", "cond"],
        },
      },
    },
    then: {
      type: "object",
      properties: { action: { type: "string" }, params: { type: "object" } },
      required: ["action"],
    },
    source: {
      type: "object",
      properties: {
        document: { type: "string" },
        page: { type: "number" },
        section: { type: "string" },
        excerpt: { type: "string", description: "Verbatim text from the source document" },
      },
      required: ["document", "excerpt"],
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    tests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          inputs: { type: "object" },
          expected: {
            type: "object",
            properties: { action: { type: "string" }, params: { type: "object" } },
            required: ["action"],
          },
        },
        required: ["inputs", "expected"],
      },
    },
  },
  required: ["id", "type", "description", "inputs", "when", "then", "source", "confidence", "tests"],
};

const DRAFT_TOOL = {
  type: "function" as const,
  function: {
    name: "draft_rules",
    description: "Return the drafted rules array",
    parameters: {
      type: "object",
      properties: { rules: { type: "array", items: RULE_ITEM_SCHEMA } },
      required: ["rules"],
    },
  },
};

const PASSES = [
  {
    label: "knockouts",
    instruction: `Draft ONLY knockout rules (type: "knockout") — conditions that automatically decline an application.
Cover every automatic-decline condition listed in the guidelines (terminal illness, metastatic cancer, supplemental oxygen, transplant, DUI/DWI, age outside band, face amount outside limits, etc.).
One rule per distinct decline condition. Do not generate eligibility or referral rules in this pass.`,
  },
  {
    label: "eligibility",
    instruction: `Draft ONLY eligibility rules (type: "eligibility") — conditions that determine whether an applicant can be offered coverage.
Cover eligibility gates: issue age bands by term length, face amount min/max limits, citizenship/residency requirements, no-exam limits by face amount and age.
One rule per distinct eligibility condition. Do not generate knockout or referral rules in this pass.`,
  },
  {
    label: "referrals",
    instruction: `Draft ONLY referral rules — conditions that require human underwriter review rather than automatic accept/decline.
Map each referral criterion to a rule with action "refer". Cover: cancer history, diabetes, cardiac events, non-citizen/non-resident, hazardous occupations/avocations, conditions not in auto-decision tables.
Use type "eligibility" with action "refer". One rule per distinct referral condition.`,
  },
  {
    label: "risk_and_evidence",
    instruction: `Draft rules for risk classification and evidence requirements:
- Risk-class gates (tobacco use, BMI/build, blood pressure, cholesterol ratio, family history, driving record): use type "rating_placeholder" since exact thresholds feed into pricing.
- Evidence/exam requirements by face amount band: use type "disclosure" with action "require_disclosure".
Do not repeat knockout or eligibility rules from previous passes.`,
  },
];

async function draftPass(
  client: OpenAI,
  schemaContext: string,
  guidelinesText: string,
  pass: { label: string; instruction: string },
): Promise<Rule[]> {
  const userPrompt = `Capture schema fields (id → label → datatype):
${schemaContext}

Guidelines and source documents:
${guidelinesText}

${pass.instruction}`;

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 8192,
    temperature: 0.1,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    tools: [DRAFT_TOOL],
    tool_choice: { type: "function", function: { name: "draft_rules" } },
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.function.name !== "draft_rules") {
    return [];
  }

  const parsed = JSON.parse(toolCall.function.arguments) as { rules: Rule[] };
  return parsed.rules ?? [];
}

export async function draftRules(
  captureSchema: CaptureField[],
  guidanceDocs: DocumentEntry[],
): Promise<Rule[]> {
  const schemaContext = captureSchema
    .flatMap((f) => {
      const line = `${f.id} | ${f.label} | ${f.datatype}`;
      if (f.datatype === "array" && f.items && f.items.length > 0) {
        const subLines = f.items.map((sub) => `  ${f.id}[].${sub.id} | ${sub.label} | ${sub.datatype}`);
        return [line, ...subLines];
      }
      return [line];
    })
    .join("\n");

  let guidelinesText = "";
  for (const doc of guidanceDocs) {
    if (!doc.rawText) continue;
    guidelinesText += `=== ${doc.name} (${doc.role}) ===\n`;
    if (doc.pages && doc.pages.length > 0) {
      for (const p of doc.pages) {
        guidelinesText += `[Page ${p.page}]\n${p.text}\n\n`;
      }
    } else {
      guidelinesText += doc.rawText + "\n\n";
    }
  }

  if (!guidelinesText) {
    guidelinesText = "(No guidelines documents provided — draft rules from the capture schema alone.)";
  }

  const client = new OpenAI();

  // Run passes sequentially to stay within per-call token limits
  const allRules: Rule[] = [];
  const seenIds = new Set<string>();

  for (const pass of PASSES) {
    const passRules = await draftPass(client, schemaContext, guidelinesText, pass);
    for (const rule of passRules) {
      if (!seenIds.has(rule.id)) {
        seenIds.add(rule.id);
        allRules.push({
          ...rule,
          status: "draft" as const,
          testStatus: "untested" as const,
          generatedBy: "gpt-4o",
        });
      }
    }
  }

  return allRules;
}
