import type { FastifyInstance } from "fastify";
import { getSession, saveSession } from "../lib/storage.js";
import { appendAudit } from "../lib/audit.js";
import type { CaptureField } from "@workbench/schema";

type FieldDatatype = CaptureField["datatype"];
const DATATYPES: FieldDatatype[] = ["string", "number", "date", "boolean", "enum", "currency", "array"];

// Editable metadata on a field. Field id and source are NOT editable here (ids are the
// contract with rules; source preserves extraction provenance).
interface FieldEdit {
  label?: string;
  section?: string;
  datatype?: FieldDatatype;
  required?: boolean;
  options?: string[];
  validation?: { min?: number; max?: number; regex?: string };
  items?: CaptureField[];
}

// Find which non-rejected rules reference a field id (in inputs or anywhere in the condition tree).
function rulesReferencing(session: NonNullable<Awaited<ReturnType<typeof getSession>>>, fieldId: string): string[] {
  const refs: string[] = [];
  for (const rule of session.rules ?? []) {
    if (rule.status === "rejected") continue;
    if (rule.inputs.includes(fieldId)) { refs.push(rule.id); continue; }
    // also scan the condition tree
    const stack = [rule.when];
    let found = false;
    while (stack.length) {
      const c = stack.pop()!;
      if (!c) continue;
      if (c.field === fieldId) { found = true; break; }
      if (c.all) stack.push(...c.all);
      if (c.any) stack.push(...c.any);
      if (c.each) stack.push(c.each.cond);
      if (c.some) stack.push(c.some.cond);
    }
    if (found) refs.push(rule.id);
  }
  return refs;
}

export async function registerSchemaRoutes(app: FastifyInstance): Promise<void> {
  // POST /sessions/:id/schema/fields — add a new field (reviewer-authored)
  app.post<{ Params: { id: string }; Body: Partial<CaptureField> }>(
    "/sessions/:id/schema/fields",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.status(404).send({ error: "Session not found" });

      const { id, label, section, datatype, required, options, validation, items } = request.body;
      if (!id || !label || !datatype) {
        return reply.status(400).send({ error: "id, label, and datatype are required" });
      }
      if (!/^[a-z][a-z0-9_]*$/.test(id)) {
        return reply.status(400).send({ error: "id must be snake_case (lowercase letters, digits, underscores)" });
      }
      if (!DATATYPES.includes(datatype)) {
        return reply.status(400).send({ error: `datatype must be one of: ${DATATYPES.join(", ")}` });
      }
      if (session.captureSchema.some((f) => f.id === id)) {
        return reply.status(409).send({ error: `A field with id "${id}" already exists` });
      }

      const field: CaptureField = {
        id,
        label,
        section: section || "Manual",
        datatype,
        required: required ?? false,
        options,
        validation,
        items,
        source: { document: "manual", excerpt: "Added by reviewer" },
        provenance: "manual",
      };
      session.captureSchema.push(field);
      // un-delete if it was previously removed
      session.deletedFieldIds = (session.deletedFieldIds ?? []).filter((d) => d !== id);

      appendAudit(session, "schema_field_added", `Added field "${id}" (${datatype})`, {
        target: id,
        details: { label, datatype, section: field.section },
      });
      await saveSession(session);
      return reply.status(201).send(session);
    },
  );

  // PATCH /sessions/:id/schema/fields/:fieldId — edit metadata of an existing field (id immutable)
  app.patch<{ Params: { id: string; fieldId: string }; Body: FieldEdit }>(
    "/sessions/:id/schema/fields/:fieldId",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.status(404).send({ error: "Session not found" });

      const field = session.captureSchema.find((f) => f.id === request.params.fieldId);
      if (!field) return reply.status(404).send({ error: "Field not found" });

      const { label, section, datatype, required, options, validation, items } = request.body;
      if (datatype !== undefined && !DATATYPES.includes(datatype)) {
        return reply.status(400).send({ error: `datatype must be one of: ${DATATYPES.join(", ")}` });
      }

      const changed: string[] = [];
      if (label !== undefined && label !== field.label) { field.label = label; changed.push("label"); }
      if (section !== undefined && section !== field.section) { field.section = section; changed.push("section"); }
      if (datatype !== undefined && datatype !== field.datatype) { field.datatype = datatype; changed.push("datatype"); }
      if (required !== undefined && required !== field.required) { field.required = required; changed.push("required"); }
      if (options !== undefined) { field.options = options; changed.push("options"); }
      if (validation !== undefined) { field.validation = validation; changed.push("validation"); }
      if (items !== undefined) { field.items = items; changed.push("items"); }

      if (changed.length === 0) {
        return reply.send(session); // nothing to do
      }

      // Mark provenance: a manually-added field stays "manual"; an extracted field becomes "edited".
      if (field.provenance !== "manual") field.provenance = "edited";

      appendAudit(session, "schema_field_edited", `Edited ${changed.join(", ")} on field "${field.id}"`, {
        target: field.id,
        details: { changed },
      });
      await saveSession(session);
      return reply.send(session);
    },
  );

  // DELETE /sessions/:id/schema/fields/:fieldId — safe-delete (only if no active rule references it)
  app.delete<{ Params: { id: string; fieldId: string } }>(
    "/sessions/:id/schema/fields/:fieldId",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.status(404).send({ error: "Session not found" });

      const field = session.captureSchema.find((f) => f.id === request.params.fieldId);
      if (!field) return reply.status(404).send({ error: "Field not found" });

      const refs = rulesReferencing(session, field.id);
      if (refs.length > 0) {
        return reply.status(409).send({
          error: `Cannot delete "${field.id}" — referenced by ${refs.length} rule(s): ${refs.join(", ")}. Reject or correct those rules first.`,
          referencingRules: refs,
        });
      }

      session.captureSchema = session.captureSchema.filter((f) => f.id !== field.id);
      // Track deletion of extracted fields so a future re-merge does not resurrect them.
      if (field.provenance !== "manual") {
        session.deletedFieldIds = [...new Set([...(session.deletedFieldIds ?? []), field.id])];
      }

      appendAudit(session, "schema_field_deleted", `Deleted field "${field.id}"`, {
        target: field.id,
        details: { provenance: field.provenance ?? "extracted" },
      });
      await saveSession(session);
      return reply.send(session);
    },
  );
}
