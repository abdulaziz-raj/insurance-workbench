import OpenAI from "openai";
import type { CaptureField } from "@workbench/schema";
import type { ExtractedDoc } from "./pdf.js";

// A leaf field (no further nesting) — used inside array items
const LEAF_FIELD_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "snake_case stable key. For sub-fields omit the parent prefix, e.g. 'construction_type' not 'location_construction_type'" },
    label: { type: "string", description: "Exact label text as it appears on the form" },
    section: { type: "string", description: "Section or group heading this field belongs to" },
    datatype: { type: "string", enum: ["string", "number", "date", "boolean", "enum", "currency"] },
    required: { type: "boolean" },
    options: { type: "array", items: { type: "string" } },
    validation: {
      type: "object",
      properties: { min: { type: "number" }, max: { type: "number" }, regex: { type: "string" } },
    },
    source: {
      type: "object",
      properties: {
        document: { type: "string" },
        page: { type: "number" },
        section: { type: "string" },
        excerpt: { type: "string", description: "EXACT verbatim text from the form — mandatory" },
      },
      required: ["document", "excerpt"],
    },
  },
  required: ["id", "label", "section", "datatype", "required", "source"],
};

// A top-level field — may itself be an array with nested items (one level deep is sufficient for COPE)
const TOP_LEVEL_FIELD_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "snake_case stable key, e.g. locations, insured_name" },
    label: { type: "string" },
    section: { type: "string" },
    datatype: {
      type: "string",
      enum: ["string", "number", "date", "boolean", "enum", "currency", "array"],
      description: "Use 'array' for repeating sections (e.g. locations, buildings, vehicles). Each item's fields go in 'items'.",
    },
    required: { type: "boolean" },
    options: { type: "array", items: { type: "string" } },
    validation: {
      type: "object",
      properties: { min: { type: "number" }, max: { type: "number" }, regex: { type: "string" } },
    },
    reflexiveTriggers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          when: { type: "string" },
          reveal: { type: "array", items: { type: "string" } },
        },
        required: ["when", "reveal"],
      },
    },
    items: {
      type: "array",
      description: "Present only when datatype is 'array'. Describes the fields of each repeating item.",
      items: LEAF_FIELD_SCHEMA,
    },
    source: {
      type: "object",
      properties: {
        document: { type: "string" },
        page: { type: "number" },
        section: { type: "string" },
        excerpt: { type: "string", description: "EXACT verbatim text from the form — mandatory" },
      },
      required: ["document", "excerpt"],
    },
  },
  required: ["id", "label", "section", "datatype", "required", "source"],
};

const CAPTURE_FIELD_SCHEMA = {
  type: "object",
  properties: {
    fields: { type: "array", items: TOP_LEVEL_FIELD_SCHEMA },
  },
  required: ["fields"],
};

const SYSTEM_PROMPT = `You are an expert insurance form analyst. Extract every field and question from the insurance application form into a structured capture schema.

Rules:
- id: snake_case stable key (e.g. applicant_first_name, tobacco_used_12mo)
- label: exact label text as it appears on the form
- section: the section or group heading this field belongs to
- datatype: string, number, date, boolean, enum, currency, or array
- required: true only if the form explicitly marks the field as required
- options: for enum/checkbox fields, list every option shown verbatim
- reflexiveTriggers: if answering this field reveals/hides other fields, capture that logic
- source.excerpt: copy the EXACT verbatim text from the form — mandatory
- source.page: the page number where this field appears

REPEATING SECTIONS (array datatype):
- If the form has a section that repeats per item (e.g., "Location 1 / Location 2", "Building Details", "Vehicle Schedule"), emit ONE field with datatype "array".
- Set id to the plural noun (e.g. "locations", "buildings", "vehicles").
- Set label to the section heading (e.g. "Property Locations").
- Put all the per-item fields in "items" — use simple ids without the parent prefix (e.g. "street_address" not "location_street_address").
- The source.excerpt for the array field should be the section heading verbatim.
- Do NOT flatten repeating sections into numbered top-level fields (location_1_address, location_2_address, etc.).

- Do NOT invent fields. Only capture what is explicitly present.
- Do NOT fabricate business rules or thresholds — those come from guidelines docs.`;

export async function extractCaptureSchema(
  doc: ExtractedDoc,
  documentName: string
): Promise<CaptureField[]> {
  const client = new OpenAI();
  const pageText = doc.pages
    .map((p) => `--- Page ${p.page} ---\n${p.text}`)
    .join("\n\n");

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Document: ${documentName}\n\nForm text (with page markers):\n${pageText}\n\nExtract all fields. Every field must include a source.excerpt copied verbatim from the text above.`,
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "capture_schema",
          description: "Return the list of capture fields extracted from the insurance form",
          parameters: CAPTURE_FIELD_SCHEMA,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "capture_schema" } },
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    throw new Error("No function call returned from OpenAI");
  }

  const parsed = JSON.parse(toolCall.function.arguments) as { fields: CaptureField[] };

  if (!Array.isArray(parsed.fields)) {
    throw new Error("Invalid response: fields is not an array");
  }

  return parsed.fields.map((field) => ({
    ...field,
    source: { ...field.source, document: documentName },
  }));
}

/**
 * Streaming variant of extractCaptureSchema. Identical model call, but the tool-call
 * arguments are consumed incrementally; `onProgress` is invoked with an approximate
 * running field count (derived from "id" keys seen so far) so the UI can show live progress.
 * Total time is the same — this just makes the wait visible.
 */
export async function extractCaptureSchemaStream(
  doc: ExtractedDoc,
  documentName: string,
  onProgress: (fieldCount: number) => void,
): Promise<CaptureField[]> {
  const client = new OpenAI();
  const pageText = doc.pages
    .map((p) => `--- Page ${p.page} ---\n${p.text}`)
    .join("\n\n");

  const stream = await client.chat.completions.create({
    model: "gpt-4o",
    stream: true,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Document: ${documentName}\n\nForm text (with page markers):\n${pageText}\n\nExtract all fields. Every field must include a source.excerpt copied verbatim from the text above.`,
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "capture_schema",
          description: "Return the list of capture fields extracted from the insurance form",
          parameters: CAPTURE_FIELD_SCHEMA,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "capture_schema" } },
  });

  let args = "";
  let lastCount = 0;
  for await (const chunk of stream) {
    const argDelta = chunk.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments;
    if (argDelta) {
      args += argDelta;
      // Each field object carries an "id" key — count them as a monotonic progress signal.
      const count = (args.match(/"id"\s*:/g) ?? []).length;
      if (count > lastCount) {
        lastCount = count;
        onProgress(count);
      }
    }
  }

  if (!args) throw new Error("No function call returned from OpenAI");

  const parsed = JSON.parse(args) as { fields: CaptureField[] };
  if (!Array.isArray(parsed.fields)) {
    throw new Error("Invalid response: fields is not an array");
  }

  return parsed.fields.map((field) => ({
    ...field,
    source: { ...field.source, document: documentName },
  }));
}
