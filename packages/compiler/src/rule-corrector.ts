import OpenAI from "openai";
import type { CaptureField, Rule } from "@workbench/schema";

const SYSTEM_PROMPT = `You are an expert insurance underwriting rules analyst.
A human reviewer has identified a problem with one drafted rule and given you a correction instruction.
Re-draft that single rule according to the instruction while keeping everything else consistent.

Requirements:
1. Keep the rule id unchanged.
2. Apply the reviewer's correction precisely — change only what they asked.
3. inputs[] must contain only field IDs that exist in the provided capture schema.
4. Every test must have correct expected.action:
   - If test inputs SATISFY the condition → expected.action = rule's then.action
   - If test inputs do NOT satisfy the condition → expected.action = "pass"
5. Generate 2–3 tests that cover both the fire case and the no-fire case.
6. Do NOT invent thresholds, rates, or risk classes not present in the guidelines.
7. source.excerpt must be verbatim text from the original source document.
8. Conditions use ops: eq, neq, gt, gte, lt, lte, in, nin, exists, true, false
   Array quantifiers: each:{field,cond} (all items) or some:{field,cond} (any item)`;

const RULE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
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
    then: {
      type: "object",
      properties: { action: { type: "string" }, params: { type: "object" } },
      required: ["action"],
    },
    source: {
      type: "object",
      properties: {
        document: { type: "string" }, page: { type: "number" },
        section: { type: "string" }, excerpt: { type: "string" },
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

export async function correctRule(
  rule: Rule,
  instruction: string,
  captureSchema: CaptureField[],
  guidelinesExcerpt: string,
): Promise<Rule> {
  const client = new OpenAI();

  const schemaContext = captureSchema
    .flatMap((f) => {
      const line = `${f.id} | ${f.label} | ${f.datatype}`;
      if (f.datatype === "array" && f.items && f.items.length > 0) {
        return [line, ...f.items.map((sub) => `  ${f.id}[].${sub.id} | ${sub.label} | ${sub.datatype}`)];
      }
      return [line];
    })
    .join("\n");

  const userPrompt = `Capture schema:
${schemaContext}

Guidelines context (for source verification):
${guidelinesExcerpt}

Current rule (JSON):
${JSON.stringify(rule, null, 2)}

Reviewer correction instruction:
"${instruction}"

Re-draft the rule applying the correction. Keep the rule id. Return the corrected rule.`;

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2048,
    temperature: 0.1,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "corrected_rule",
          description: "Return the corrected rule",
          parameters: {
            type: "object",
            properties: { rule: RULE_ITEM_SCHEMA },
            required: ["rule"],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "corrected_rule" } },
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    throw new Error("No function call returned from OpenAI");
  }

  const parsed = JSON.parse(toolCall.function.arguments) as { rule: Rule };
  return {
    ...parsed.rule,
    id: rule.id, // id is immutable
    status: "needs_review" as const, // reviewer must re-approve after correction
    testStatus: "untested" as const,
    generatedBy: rule.generatedBy,
    approvedBy: undefined,
    reviewedAt: undefined,
  };
}
