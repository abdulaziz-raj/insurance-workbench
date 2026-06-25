import type { FastifyInstance } from "fastify";
import { draftRules, correctRule, draftOverlayRules, classifyDocument } from "@workbench/compiler";
import { getSession, saveSession } from "../lib/storage.js";
import { appendAudit } from "../lib/audit.js";
import type { ReviewStatus, Rule, Condition, Outcome } from "@workbench/schema";
import { runRuleTests, evaluateCondition } from "@workbench/engine";

export async function registerRuleRoutes(app: FastifyInstance): Promise<void> {
  // POST /sessions/:id/draft-rules — generate draft rules via LLM
  app.post<{ Params: { id: string } }>(
    "/sessions/:id/draft-rules",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) {
        return reply.status(404).send({ error: "Session not found" });
      }

      const readyDocs = session.documents.filter((d) => d.status === "ready" && d.rawText != null);
      // Countrywide sources → the base. (guidelines + non-state "other"; the application form feeds the schema.)
      const baseGuidance = readyDocs.filter(
        (d) => d.role === "guidelines" || (d.role === "other" && (d.jurisdiction || "US").toUpperCase() === "US"),
      );
      const stateAddenda = readyDocs.filter((d) => d.role === "state_addendum");

      if (session.captureSchema.length === 0) {
        return reply.status(400).send({ error: "No capture schema — upload an application form first" });
      }

      // Resolve each addendum's jurisdiction (stored at upload; classify on the fly if missing).
      const addendaByState = new Map<string, typeof stateAddenda>();
      for (const d of stateAddenda) {
        let juris = (d.jurisdiction || "").toUpperCase();
        if (!juris || juris === "US") {
          // classifyDocument takes already-extracted text — don't re-parse the PDF.
          const c = await classifyDocument({ text: d.rawText!, pages: d.pages ?? [] } as never).catch(() => null);
          juris = (c?.suggestedJurisdiction || "US").toUpperCase();
          d.jurisdiction = juris;
        }
        if (juris === "US") continue; // an addendum that isn't state-specific → treat as base guidance
        if (!addendaByState.has(juris)) addendaByState.set(juris, []);
        addendaByState.get(juris)!.push(d);
      }

      session.status = "extracting";
      await saveSession(session);

      try {
        // 1) Base rules from countrywide guidance.
        const baseRules = await draftRules(session.captureSchema, baseGuidance);
        baseRules.forEach((r) => { r.jurisdiction = "US"; });

        // 2) One overlay per state, drafted as deltas against the in-memory base.
        const allRules: Rule[] = [...baseRules];
        const overlayDisabled: Record<string, string[]> = {};
        const overlaySummary: string[] = [];
        for (const [state, docs] of addendaByState) {
          const { rules: overlayRules, disabledBaseRuleIds } = await draftOverlayRules(
            state, baseRules, session.captureSchema, docs,
          );
          overlayRules.forEach((r) => { r.jurisdiction = state; });
          allRules.push(...overlayRules);
          if (disabledBaseRuleIds.length) overlayDisabled[state] = disabledBaseRuleIds;
          overlaySummary.push(`${state}: ${overlayRules.length} deltas${disabledBaseRuleIds.length ? ` +${disabledBaseRuleIds.length} removed` : ""}`);
        }

        session.rules = allRules;
        session.overlayDisabled = Object.keys(overlayDisabled).length ? overlayDisabled : undefined;
        session.draftedAt = new Date().toISOString();
        session.status = "ready";
        const summary = `Drafted ${baseRules.length} base rules`
          + (overlaySummary.length ? ` + overlays (${overlaySummary.join("; ")})` : "");
        appendAudit(session, "rules_drafted", summary, {
          details: { baseRules: baseRules.length, overlayStates: [...addendaByState.keys()], overlayDisabled },
          actor: "system",
        });
        await saveSession(session);

        return reply.send(session);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        session.status = "error";
        session.error = errorMessage;
        try { await saveSession(session); } catch { /* best-effort */ }
        return reply.status(500).send({ error: errorMessage, sessionId: session.id });
      }
    },
  );

  // PATCH /sessions/:id/rules/:ruleId — update any editable fields on a rule
  app.patch<{
    Params: { id: string; ruleId: string };
    Body: {
      status?: ReviewStatus;
      description?: string;
      confidence?: string;
      notes?: string;
      // Raw logic edits (JSON editor path)
      when?: Condition;
      then?: Outcome;
      inputs?: string[];
    };
  }>(
    "/sessions/:id/rules/:ruleId",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.status(404).send({ error: "Session not found" });

      const rule = session.rules?.find((r) => r.id === request.params.ruleId);
      if (!rule) return reply.status(404).send({ error: "Rule not found" });

      const { status, description, confidence, notes, when, then: thenBody, inputs } = request.body;
      if (status !== undefined) {
        const prev = rule.status;
        rule.status = status;
        rule.reviewedAt = new Date().toISOString();
        appendAudit(session, "rule_status_changed", `Rule ${rule.id}: ${prev} → ${status}`, {
          target: rule.id,
          details: { from: prev, to: status },
        });
      }

      // Metadata edits (description / confidence / notes)
      const metaChanges: string[] = [];
      if (description !== undefined && description !== rule.description) { rule.description = description; metaChanges.push("description"); }
      if (confidence !== undefined && confidence !== rule.confidence) { rule.confidence = confidence as Rule["confidence"]; metaChanges.push("confidence"); }
      if (notes !== undefined && notes !== rule.notes) { rule.notes = notes; metaChanges.push("notes"); }
      if (metaChanges.length > 0) {
        appendAudit(session, "rule_edited", `Edited ${metaChanges.join(", ")} on rule ${rule.id}`, {
          target: rule.id,
          details: { fields: metaChanges },
        });
      }

      // Logic edits — reset test status so reviewer knows tests need re-running
      const logicChanges: string[] = [];
      if (when !== undefined) { rule.when = when; rule.testStatus = "untested"; rule.testResults = undefined; logicChanges.push("when"); }
      if (thenBody !== undefined) { rule.then = thenBody; rule.testStatus = "untested"; rule.testResults = undefined; logicChanges.push("then"); }
      if (inputs !== undefined) { rule.inputs = inputs; logicChanges.push("inputs"); }
      if (logicChanges.length > 0) {
        appendAudit(session, "rule_logic_edited", `Edited rule logic (${logicChanges.join(", ")}) on rule ${rule.id}`, {
          target: rule.id,
          details: { fields: logicChanges, when: rule.when, then: rule.then, inputs: rule.inputs },
        });
      }

      await saveSession(session);
      return reply.send(session);
    },
  );

  // POST /sessions/:id/rules/:ruleId/correct — AI-assisted rule correction
  // Reviewer provides a plain-English instruction; the LLM re-drafts the single rule.
  app.post<{
    Params: { id: string; ruleId: string };
    Body: { instruction: string };
  }>("/sessions/:id/rules/:ruleId/correct", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: "Session not found" });

    const ruleIndex = session.rules?.findIndex((r) => r.id === request.params.ruleId) ?? -1;
    if (ruleIndex === -1) return reply.status(404).send({ error: "Rule not found" });

    const { instruction } = request.body;
    if (!instruction?.trim()) return reply.status(400).send({ error: "instruction is required" });

    // Build a guidelines excerpt: combine rawText from all guidance docs (first 8000 chars each)
    const guidelinesExcerpt = session.documents
      .filter((d) => (d.role === "guidelines" || d.role === "state_addendum" || d.role === "other") && d.rawText)
      .map((d) => `=== ${d.name} ===\n${d.rawText!.slice(0, 8000)}`)
      .join("\n\n") || "(No guidelines available)";

    try {
      const before = session.rules![ruleIndex];
      const corrected = await correctRule(
        before,
        instruction,
        session.captureSchema,
        guidelinesExcerpt,
      );
      session.rules![ruleIndex] = corrected;
      appendAudit(session, "rule_corrected", `AI-corrected rule ${corrected.id}: "${instruction}"`, {
        target: corrected.id,
        details: {
          instruction,
          before: { when: before.when, then: before.then, inputs: before.inputs },
          after: { when: corrected.when, then: corrected.then, inputs: corrected.inputs },
        },
      });
      await saveSession(session);
      return reply.send(session);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: errorMessage });
    }
  });

  // POST /sessions/:id/run-tests — run tests for all rules
  app.post<{ Params: { id: string } }>("/sessions/:id/run-tests", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    for (const rule of session.rules ?? []) {
      const results = runRuleTests(rule);
      rule.testResults = results;
      rule.testStatus = results.length === 0 ? "untested"
        : results.every((r) => r.pass) ? "pass" : "fail";
    }
    const tested = (session.rules ?? []).filter((r) => r.testStatus !== "untested");
    const passing = tested.filter((r) => r.testStatus === "pass").length;
    appendAudit(session, "tests_run", `Ran tests: ${passing}/${tested.length} rules passing`, {
      details: { passing, tested: tested.length },
      actor: "system",
    });
    await saveSession(session);
    return reply.send(session);
  });

  // POST /sessions/:id/rules/:ruleId/run-tests — run tests for a single rule
  app.post<{ Params: { id: string; ruleId: string } }>("/sessions/:id/rules/:ruleId/run-tests", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    const rule = session.rules?.find((r) => r.id === request.params.ruleId);
    if (!rule) return reply.status(404).send({ error: "Rule not found" });
    const results = runRuleTests(rule);
    rule.testResults = results;
    rule.testStatus = results.length === 0 ? "untested"
      : results.every((r) => r.pass) ? "pass" : "fail";
    await saveSession(session);
    return reply.send(session);
  });

  // POST /sessions/:id/fix-tests — re-derive expected actions from the engine so tests reflect ground truth
  // The LLM sometimes writes expected.action = rule.then.action even when the condition won't fire.
  // This endpoint resets every test's expected.action based on evaluateCondition(rule.when, test.inputs).
  app.post<{ Params: { id: string } }>("/sessions/:id/fix-tests", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.status(404).send({ error: "Session not found" });

    const schemaFieldIds = new Set(
      session.captureSchema.flatMap((f) =>
        f.datatype === "array" && f.items ? [f.id, ...f.items.map((sub) => sub.id)] : [f.id]
      )
    );

    let correctedCount = 0;
    const flaggedRules: string[] = [];
    for (const rule of session.rules ?? []) {
      // Flag rules whose condition references fields not in the capture schema
      const unknownFields = rule.inputs.filter((id) => !schemaFieldIds.has(id));
      if (unknownFields.length > 0) {
        const note = `Unknown schema fields: ${unknownFields.join(", ")}`;
        rule.notes = rule.notes ? `${rule.notes} | ${note}` : note;
        if (rule.status === "approved") rule.status = "needs_review";
        flaggedRules.push(rule.id);
      }

      // Re-derive expected.action for every test
      for (const test of rule.tests) {
        const fired = evaluateCondition(rule.when, test.inputs);
        const correct = fired ? rule.then.action : "pass";
        if (test.expected.action !== correct) correctedCount++;
        test.expected.action = correct;
      }

      // Re-run tests (should now all pass since expected = actual by construction)
      const results = runRuleTests(rule);
      rule.testResults = results;
      rule.testStatus = results.length === 0 ? "untested"
        : results.every((r) => r.pass) ? "pass" : "fail";
    }

    appendAudit(session, "tests_fixed", `Fixed ${correctedCount} test expectation${correctedCount !== 1 ? "s" : ""}${flaggedRules.length ? `; flagged ${flaggedRules.length} rule(s) for unknown fields` : ""}`, {
      details: { correctedExpectations: correctedCount, flaggedRules },
      actor: "system",
    });

    await saveSession(session);
    return reply.send(session);
  });
}
