import OpenAI from "openai";
import type { DocumentRole } from "@workbench/schema";
import type { ExtractedDoc } from "./pdf.js";

const ROLES: DocumentRole[] = ["application_form", "acord_form", "guidelines", "state_addendum", "other"];

const SYSTEM_PROMPT = `You classify insurance PDF documents into one role, and (when the document identifies a product) suggest a concise product name.
Judge by the document's overall PURPOSE and TITLE, not merely by the presence of fillable fields — many ancillary forms contain questions too.

Roles:
- application_form: the PRIMARY application used to apply for the policy — it captures the proposed insured's identity, coverage selection, and health/financial data. This is the main intake form, not a supplement to it.
- acord_form: a standardized ACORD form (look for "ACORD" and a form number like "ACORD 125").
- guidelines: underwriting guidelines / manual — prose describing eligibility, knockouts, referrals, risk classes, limits.
- state_addendum: a state-specific addendum, amendatory endorsement, or replacement form tied to one US state.
- other: any ancillary or supplementary document that is NOT the primary application and NOT underwriting guidelines. This includes notices and disclosures (e.g. MIB pre-notice, Fair Credit Reporting Act notice), authorizations (e.g. HIPAA), replacement questionnaires, beneficiary designation forms, cover letters, and marketing. A "Notice", "Disclosure", "Authorization", "Questionnaire", or "Supplement" is "other" — even though it has questions — unless it is the main application itself.

Product name: suggest the PRODUCT LINE only — WITHOUT any state or year (e.g. "Term Life", "Commercial Property").
Keep it state-free so a countrywide base and its state overlays share the same product name. Suggest it whenever the
product line is evident from the document — INCLUDING state addenda and notices, which usually reference the base
product (e.g. an addendum that says "overrides to the base term life guidelines" → "Term Life"). Omit only if unclear.

Jurisdiction: set "jurisdiction" to a 2-letter US state code (e.g. "CA", "NY", "TX") ONLY when the document is
specific to a single US state — a state addendum, amendatory endorsement, or a form clearly scoped/filed for one
state. For countrywide / national documents (most guidelines and base application forms), set "US".`;

const TOOL = {
  type: "function" as const,
  function: {
    name: "classify_document",
    description: "Return the document role and an optional suggested product name",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", enum: ROLES },
        productName: {
          type: "string",
          description: "Product LINE only, no state/year (e.g. 'Term Life'); omit if unclear",
        },
        jurisdiction: {
          type: "string",
          description: "2-letter US state code if the doc is state-specific (e.g. 'CA'); otherwise 'US'",
        },
      },
      required: ["role"],
    },
  },
};

export interface DocumentClassification {
  role: DocumentRole;
  suggestedProductName: string | null;
  // "US" (countrywide) or a state code if the document is state-specific.
  suggestedJurisdiction: string;
}

/**
 * Classify a document's role from its text, and optionally suggest a product name.
 * A small, fast call (only the first slice of text is sent). Falls back to "other"
 * on any failure so it never blocks an upload.
 */
export async function classifyDocument(doc: ExtractedDoc): Promise<DocumentClassification> {
  try {
    const client = new OpenAI();
    const sample = doc.text.slice(0, 6000);

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: sample },
      ],
      tools: [TOOL],
      tool_choice: { type: "function", function: { name: "classify_document" } },
    });

    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== "function") {
      return { role: "other", suggestedProductName: null, suggestedJurisdiction: "US" };
    }
    const parsed = JSON.parse(toolCall.function.arguments) as { role?: string; productName?: string; jurisdiction?: string };
    const role = (ROLES.includes(parsed.role as DocumentRole) ? parsed.role : "other") as DocumentRole;
    const juris = parsed.jurisdiction?.trim().toUpperCase() || "US";
    return { role, suggestedProductName: parsed.productName?.trim() || null, suggestedJurisdiction: juris };
  } catch {
    return { role: "other", suggestedProductName: null, suggestedJurisdiction: "US" };
  }
}
