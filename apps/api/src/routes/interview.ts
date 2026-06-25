import type { FastifyInstance } from "fastify";
import type { CaptureField, Rule } from "@workbench/schema";
import { getRuleset } from "../lib/ruleset-storage.js";
import { interviewState } from "@workbench/engine";

export async function registerInterviewRoutes(app: FastifyInstance): Promise<void> {
  // POST /interview-step — stateless evaluation on a caller-supplied ruleset (rules + schema).
  // Used by the chat backend, which merges the base + the applicant's state overlay itself and
  // posts the merged rules here so the interview runs against the right jurisdiction.
  app.post<{ Body: { rules?: Rule[]; captureSchema?: CaptureField[]; answers?: Record<string, unknown> } }>(
    "/interview-step",
    async (request, reply) => {
      const { rules, captureSchema, answers } = request.body ?? {};
      if (!Array.isArray(rules)) return reply.status(400).send({ error: "rules[] is required" });
      return reply.send(interviewState(rules, captureSchema ?? [], answers ?? {}));
    },
  );

  // POST /rulesets/:id/interview-step — deterministic evaluation for a natural, LLM-led interview.
  // Body: { answers: { <fieldId>: value, ... } }
  // Returns the engine state: a final decision (if reached) OR the info still needed
  // (pendingFields) plus the rules that have fired. The chat agent uses this as guidance while
  // conducting the conversation; the engine owns evaluation + the decision.
  app.post<{ Params: { id: string }; Body: { answers?: Record<string, unknown> } }>(
    "/rulesets/:id/interview-step",
    async (request, reply) => {
      const ruleset = await getRuleset(request.params.id);
      if (!ruleset) return reply.status(404).send({ error: "Ruleset not found" });

      const answers = request.body?.answers ?? {};
      const state = interviewState(ruleset.rules, ruleset.captureSchema, answers);
      return reply.send(state);
    },
  );
}
