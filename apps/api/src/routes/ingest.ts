import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { extractPdfText, extractCaptureSchema, extractCaptureSchemaStream, classifyDocument } from "@workbench/compiler";
import { saveSession, getSession, listSessions } from "../lib/storage.js";
import { appendAudit } from "../lib/audit.js";
import type { Session, DocumentEntry, DocumentRole, CaptureField } from "@workbench/schema";

// Document roles that contribute fields to the capture schema. The others
// (guidelines, state_addendum, other) are rule-drafting sources only — running field
// extraction on their prose just produces noise, so it's skipped (also much faster).
const SCHEMA_ROLES: DocumentRole[] = ["application_form", "acord_form"];

// Merge extracted fields across documents, while preserving reviewer edits/additions
// and honoring reviewer deletions. `prior` is the session's current captureSchema (which
// holds any manual/edited fields); `deletedIds` are AI-extracted fields the reviewer removed.
function mergeFields(
  documents: DocumentEntry[],
  prior: CaptureField[] = [],
  deletedIds: string[] = [],
): CaptureField[] {
  const priorById = new Map(prior.map((f) => [f.id, f]));
  const deleted = new Set(deletedIds);
  const seen = new Set<string>();
  const merged: CaptureField[] = [];

  for (const doc of documents) {
    if (doc.status !== "ready") continue;
    for (const field of doc.fields) {
      if (seen.has(field.id) || deleted.has(field.id)) continue;
      seen.add(field.id);
      // If the reviewer edited this extracted field, their version wins over re-extraction.
      const priorVersion = priorById.get(field.id);
      merged.push(priorVersion?.provenance === "edited" ? priorVersion : field);
    }
  }

  // Preserve reviewer intent: append manual fields AND edited fields that the fresh
  // extraction did not reproduce. Without this, LLM nondeterminism could silently drop
  // a field a reviewer added or edited.
  for (const f of prior) {
    if ((f.provenance === "manual" || f.provenance === "edited") && !seen.has(f.id)) {
      seen.add(f.id);
      merged.push(f);
    }
  }

  return merged;
}

export async function registerIngestRoutes(
  app: FastifyInstance
): Promise<void> {
  // POST /sessions — create an empty session
  app.post<{ Body: { productName: string; jurisdiction?: string } }>("/sessions", async (request, reply) => {
    const session: Session = {
      id: uuidv4(),
      productName: request.body.productName || "Untitled Ruleset",
      jurisdiction: request.body.jurisdiction?.trim() || "US",
      createdAt: new Date().toISOString(),
      status: "empty",
      documents: [],
      captureSchema: [],
    };
    await saveSession(session);
    return reply.status(201).send(session);
  });

  // POST /sessions/:id/documents — upload + extract a document.
  // Add ?stream=1 (or Accept: application/x-ndjson) to receive live progress as NDJSON:
  //   {"type":"progress","fields":N}  …  {"type":"done","session":{…}}  | {"type":"error","error":"…"}
  // Without it, behaves as before (returns the Session JSON once extraction completes).
  app.post<{ Params: { id: string }; Querystring: { stream?: string } }>(
    "/sessions/:id/documents",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) {
        return reply.status(404).send({ error: "Session not found" });
      }

      const VALID_ROLES: DocumentRole[] = ["application_form", "acord_form", "guidelines", "state_addendum", "other"];

      let fileBuffer: Buffer | null = null;
      let filename = "unknown.pdf";
      // "auto" (or absent/invalid) → the server classifies the document type itself.
      let rawRole = "auto";

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "file") {
          fileBuffer = await part.toBuffer();
          filename = part.filename || "unknown.pdf";
        } else if (part.type === "field" && part.fieldname === "role") {
          rawRole = (part.value as string) || "auto";
        }
      }

      if (!fileBuffer) {
        return reply.status(400).send({ error: "No file uploaded" });
      }

      const needsClassify = rawRole === "auto" || !VALID_ROLES.includes(rawRole as DocumentRole);

      const docEntry: DocumentEntry = {
        id: uuidv4(),
        name: filename,
        role: needsClassify ? "other" : (rawRole as DocumentRole), // tentative until classified
        uploadedAt: new Date().toISOString(),
        status: "extracting",
        fields: [],
      };

      session.documents.push(docEntry);
      session.status = "extracting";
      await saveSession(session);

      const wantsStream =
        request.query.stream === "1" || request.headers.accept === "application/x-ndjson";

      // Classify the document (role + suggested product name) when the caller didn't pin a role.
      // Sets docEntry.role, and auto-names the session if it's still unnamed.
      const classifyIfNeeded = async (doc: { text: string }) => {
        if (!needsClassify) return null;
        const c = await classifyDocument(doc as never);
        docEntry.role = c.role;
        if (c.suggestedProductName && (!session.productName || session.productName === "Untitled Ruleset")) {
          session.productName = c.suggestedProductName;
        }
        // Tag the document with its detected jurisdiction. In the combined model this routes a
        // state addendum into that state's overlay at draft time; the session stays the product (base).
        docEntry.jurisdiction = c.suggestedJurisdiction || "US";
        return c;
      };

      // Shared post-extraction bookkeeping
      const finalizeOk = async (captureSchema: typeof docEntry.fields, doc: { text: string; pages: { page: number; text: string }[] }) => {
        docEntry.status = "ready";
        docEntry.fields = captureSchema;
        docEntry.rawText = doc.text;
        docEntry.pages = doc.pages;
        session.captureSchema = mergeFields(session.documents, session.captureSchema, session.deletedFieldIds);
        session.status = "ready";
        const isSchemaSource = SCHEMA_ROLES.includes(docEntry.role);
        const summary = isSchemaSource
          ? `Uploaded "${filename}" (${docEntry.role}) — extracted ${captureSchema.length} fields`
          : `Uploaded "${filename}" (${docEntry.role}) — stored as a rule-drafting source`;
        appendAudit(session, "document_uploaded", summary, {
          target: filename,
          details: { role: docEntry.role, autoDetected: needsClassify, schemaSource: isSchemaSource, fieldCount: captureSchema.length },
          actor: "system",
        });
        await saveSession(session);
      };

      const finalizeErr = async (errorMessage: string) => {
        docEntry.status = "error";
        docEntry.error = errorMessage;
        const hasAnyReady = session.documents.some((d) => d.status === "ready");
        session.status = hasAnyReady ? "ready" : "error";
        if (!hasAnyReady) session.error = errorMessage;
        try { await saveSession(session); } catch { /* best-effort */ }
      };

      // ---- Streaming path (NDJSON) ----
      if (wantsStream) {
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        });
        const write = (obj: unknown) => raw.write(JSON.stringify(obj) + "\n");

        try {
          const doc = await extractPdfText(fileBuffer);
          await classifyIfNeeded(doc);
          write({
            type: "classified",
            role: docEntry.role,
            productName: session.productName !== "Untitled Ruleset" ? session.productName : undefined,
            jurisdiction: docEntry.jurisdiction || "US",
          });
          // Only application/ACORD forms build the capture schema; supporting docs
          // (guidelines/addenda/notices) are rule sources only — skip field extraction.
          const captureSchema = SCHEMA_ROLES.includes(docEntry.role)
            ? await extractCaptureSchemaStream(doc, filename, (n) => write({ type: "progress", fields: n }))
            : [];
          await finalizeOk(captureSchema, doc);
          write({ type: "done", session });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          await finalizeErr(errorMessage);
          write({ type: "error", error: errorMessage });
        } finally {
          raw.end();
        }
        return;
      }

      // ---- Non-streaming path (JSON) ----
      try {
        const doc = await extractPdfText(fileBuffer);
        await classifyIfNeeded(doc);
        const captureSchema = SCHEMA_ROLES.includes(docEntry.role)
          ? await extractCaptureSchema(doc, filename)
          : [];
        await finalizeOk(captureSchema, doc);
        return reply.send(session);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await finalizeErr(errorMessage);
        return reply.status(422).send({ error: errorMessage, sessionId: session.id });
      }
    }
  );

  // PATCH /sessions/:id — rename the product / ruleset and/or set its jurisdiction
  app.patch<{ Params: { id: string }; Body: { productName?: string; jurisdiction?: string } }>(
    "/sessions/:id",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.status(404).send({ error: "Session not found" });

      let changed = false;
      const newName = request.body.productName?.trim();
      if (newName && newName !== session.productName) {
        const old = session.productName;
        session.productName = newName;
        appendAudit(session, "session_renamed", `Renamed product: "${old}" → "${newName}"`, {
          details: { from: old, to: newName },
        });
        changed = true;
      }

      const newJuris = request.body.jurisdiction?.trim();
      if (newJuris && newJuris !== (session.jurisdiction || "US")) {
        const old = session.jurisdiction || "US";
        session.jurisdiction = newJuris;
        appendAudit(session, "session_renamed", `Changed jurisdiction: ${old} → ${newJuris}`, {
          details: { from: old, to: newJuris, field: "jurisdiction" },
        });
        changed = true;
      }

      if (changed) await saveSession(session);
      return reply.send(session);
    },
  );

  // PATCH /sessions/:id/documents/:docId — change a document's role (override auto-detection)
  app.patch<{ Params: { id: string; docId: string }; Body: { role?: DocumentRole } }>(
    "/sessions/:id/documents/:docId",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.status(404).send({ error: "Session not found" });

      const doc = session.documents.find((d) => d.id === request.params.docId);
      if (!doc) return reply.status(404).send({ error: "Document not found" });

      const validRoles: DocumentRole[] = ["application_form", "acord_form", "guidelines", "state_addendum", "other"];
      const role = request.body.role;
      if (!role || !validRoles.includes(role)) {
        return reply.status(400).send({ error: `role must be one of: ${validRoles.join(", ")}` });
      }

      if (role !== doc.role) {
        const old = doc.role;
        doc.role = role;
        // Keep the schema consistent: a doc that's no longer a form source must not
        // contribute fields. (To populate fields for a doc newly marked as a form, re-extract.)
        if (!SCHEMA_ROLES.includes(role)) doc.fields = [];
        session.captureSchema = mergeFields(session.documents, session.captureSchema, session.deletedFieldIds);
        appendAudit(session, "document_role_changed", `Changed role of "${doc.name}": ${old} → ${role}`, {
          target: doc.name,
          details: { from: old, to: role },
        });
        await saveSession(session);
      }
      return reply.send(session);
    },
  );

  // POST /sessions/:id/re-extract — re-run schema extraction on all documents with stored rawText
  app.post<{ Params: { id: string } }>("/sessions/:id/re-extract", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: "Session not found" });

    const docsWithText = session.documents.filter((d) => d.rawText && d.status === "ready");
    if (docsWithText.length === 0) {
      return reply.status(400).send({ error: "No documents with stored text — re-upload the files" });
    }

    session.status = "extracting";
    await saveSession(session);

    try {
      for (const doc of docsWithText) {
        // Only re-extract fields for schema-source roles; rule sources contribute no fields.
        if (SCHEMA_ROLES.includes(doc.role)) {
          const pages = doc.pages ?? [{ page: 1, text: doc.rawText! }];
          const fields = await extractCaptureSchema({ text: doc.rawText!, pages }, doc.name);
          doc.fields = fields;
        } else {
          doc.fields = [];
        }
      }
      session.captureSchema = mergeFields(session.documents, session.captureSchema, session.deletedFieldIds);
      session.status = "ready";
      appendAudit(session, "schema_extracted", `Re-extracted schema from ${docsWithText.length} document(s) — ${session.captureSchema.length} fields`, {
        details: { documentCount: docsWithText.length, fieldCount: session.captureSchema.length },
        actor: "system",
      });
      await saveSession(session);
      return reply.send(session);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      session.status = "error";
      session.error = errorMessage;
      try { await saveSession(session); } catch { /* best-effort */ }
      return reply.status(500).send({ error: errorMessage });
    }
  });

  // GET /sessions — list all sessions
  app.get("/sessions", async (_request, reply) => {
    const sessions = await listSessions();
    return reply.send(sessions);
  });

  // GET /sessions/:id — get a specific session
  app.get<{ Params: { id: string } }>(
    "/sessions/:id",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) {
        return reply.status(404).send({ error: "Session not found" });
      }
      return reply.send(session);
    }
  );
}
