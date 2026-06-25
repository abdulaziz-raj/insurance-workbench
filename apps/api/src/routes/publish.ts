import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { getSession, saveSession } from "../lib/storage.js";
import { saveRuleset, getRuleset, listRulesets, nextVersionNumber } from "../lib/ruleset-storage.js";
import { appendAudit } from "../lib/audit.js";
import type { CaptureField, CoverageReport, Rule, RulesetVersion, Session } from "@workbench/schema";

function buildCoverageReport(rules: Rule[], captureSchema: CaptureField[]): CoverageReport {
  const usedFields = new Set(rules.flatMap((r) => r.inputs));
  const allFieldIds = captureSchema.map((f) => f.id);
  const unusedFields = allFieldIds.filter((id) => !usedFields.has(id));

  const rulesMissingInputs = rules.filter((r) => r.inputs.length === 0).map((r) => r.id);

  const sections = [...new Set(captureSchema.map((f) => f.section).filter(Boolean))];
  const sectionsWithRules = new Set(
    rules.flatMap((r) =>
      r.inputs
        .map((id) => captureSchema.find((f) => f.id === id)?.section)
        .filter(Boolean) as string[]
    )
  );
  const sectionsWithNoRules = sections.filter((s) => !sectionsWithRules.has(s));

  return { unusedFields, rulesMissingInputs, sectionsWithNoRules };
}

export async function registerPublishRoutes(app: FastifyInstance): Promise<void> {
  // POST /sessions/:id/publish — publish the base + one overlay per state, grouped by each
  // approved rule's jurisdiction. Returns { published: RulesetVersion[] }.
  app.post<{ Params: { id: string }; Body: { effectiveDate?: string } }>(
    "/sessions/:id/publish",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.status(404).send({ error: "Session not found" });

      const approvedRules = (session.rules ?? []).filter((r) => r.status === "approved");
      if (approvedRules.length === 0) {
        return reply.status(400).send({ error: "No approved rules to publish" });
      }

      const undecided = (session.rules ?? []).filter(
        (r) => r.status === "draft" || r.status === "needs_review"
      );
      if (undecided.length > 0) {
        return reply.status(400).send({
          error: `${undecided.length} rule${undecided.length !== 1 ? "s" : ""} still need a decision (approve or reject each before publishing)`,
        });
      }

      const now = new Date().toISOString();
      const effectiveDate = request.body?.effectiveDate?.trim() || now.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
        return reply.status(400).send({ error: "effectiveDate must be in YYYY-MM-DD format" });
      }

      // Group approved rules by jurisdiction → one ruleset each (US = base, others = overlays).
      const byJuris = new Map<string, Rule[]>();
      for (const r of approvedRules) {
        const j = (r.jurisdiction || "US").trim() || "US";
        if (!byJuris.has(j)) byJuris.set(j, []);
        byJuris.get(j)!.push(r);
      }
      // Publish base first, then states alphabetically.
      const order = [...byJuris.keys()].sort((a, b) => (a === "US" ? -1 : b === "US" ? 1 : a.localeCompare(b)));

      const published: RulesetVersion[] = [];
      for (const juris of order) {
        const rules = byJuris.get(juris)!;
        const kind: RulesetVersion["kind"] = juris === "US" ? "base" : "overlay";
        const versionNumber = await nextVersionNumber(session.productName, juris);
        const disabled = kind === "overlay" ? (session.overlayDisabled?.[juris] ?? []) : [];

        const ruleset: RulesetVersion = {
          id: uuidv4(),
          version: `v${versionNumber}`,
          productName: session.productName,
          jurisdiction: juris,
          kind,
          ...(disabled.length ? { disabledBaseRuleIds: disabled } : {}),
          effectiveDate,
          status: "published",
          captureSchema: session.captureSchema,
          rules,
          coverage: buildCoverageReport(rules, session.captureSchema),
          createdAt: now,
          publishedAt: now,
          sessionId: session.id,
        };
        await saveRuleset(ruleset);
        published.push(ruleset);

        appendAudit(session, "ruleset_published", `Published ${ruleset.version} (${kind}, ${juris}) — ${rules.length} rules${disabled.length ? `, ${disabled.length} base removed` : ""}`, {
          target: `${juris} ${ruleset.version}`,
          details: { rulesetId: ruleset.id, version: ruleset.version, jurisdiction: juris, kind, rules: rules.length, disabledBaseRuleIds: disabled, effectiveDate },
        });
      }

      await saveSession(session);
      return reply.status(201).send({ published });
    }
  );

  // GET /rulesets — list all published rulesets
  app.get("/rulesets", async (_request, reply) => {
    const rulesets = await listRulesets();
    return reply.send(rulesets);
  });

  // GET /rulesets/:id — get a specific ruleset (the Read API for Phase 5 integration)
  app.get<{ Params: { id: string } }>(
    "/rulesets/:id",
    async (request, reply) => {
      const ruleset = await getRuleset(request.params.id);
      if (!ruleset) return reply.status(404).send({ error: "Ruleset not found" });
      return reply.send(ruleset);
    }
  );
}
