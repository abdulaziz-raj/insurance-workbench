# Rules Authoring Workbench

A workbench for turning insurance documents (PDFs) into **executable, reviewable underwriting rulesets**. It ingests application forms, underwriting guidelines, and state addenda; uses an LLM to draft a capture schema and a candidate ruleset; lets a human review, edit, approve, and publish versioned rulesets; and exposes a deterministic decision engine that a downstream app (e.g. an eligibility chatbot) can call.

## How it works

```
PDFs ──▶ ingest ──▶ schema + draft rules ──▶ human review/edit ──▶ publish (versioned)
 (compiler, gpt-4o)        (web UI)              (engine evaluates)
                                                       │
                                                       ▼
                                          deterministic interview API
                                       (consumed by the eligibility chatbot)
```

- **Documents are classified automatically** by role (application form, guidelines, state addendum, …). Only application/ACORD forms drive schema extraction; guideline docs feed rule drafting.
- **Rulesets are versioned and scoped** by product, jurisdiction, and effective date. A countrywide **base** ruleset (`US`) can be combined with **state overlays** (e.g. `CA`) that override base rules by id, add new rules, or disable base rules.
- **No invented numbers.** The drafter is constrained to the source documents — it must not fabricate thresholds, rates, or risk classes.
- **The engine is deterministic.** Decisions and the adaptive interview (what to ask next) come from rule evaluation, not the LLM.

## Tech stack

| Layer | Stack | Port |
|-------|-------|------|
| `apps/api` | Fastify 5 (TypeScript, tsx) | 3001 |
| `apps/web` | React 18 + Vite 6 + Tailwind | 5173 |
| `packages/schema` | Shared types (rules, conditions, capture fields) | — |
| `packages/compiler` | PDF parsing + LLM drafting (OpenAI `gpt-4o`) | — |
| `packages/engine` | Rule evaluation + adaptive interview state | — |

npm workspaces monorepo. The engine and schema have no LLM dependency.

## Prerequisites

- Node.js 20+
- An OpenAI API key (used by `packages/compiler` for schema/rule drafting)

## Setup

```bash
npm install

# Configure your key
cp .env.example .env
# then edit .env and set OPENAI_API_KEY=sk-...
```

`.env` is gitignored — never commit a real key.

## Running

```bash
npm run dev
```

Starts both services concurrently:
- API → http://localhost:3001
- Web → http://localhost:5173

Other scripts:

```bash
npm run typecheck      # tsc --build across all workspaces
npm run seed           # upload the fixture PDFs into dev sessions
npm run seed:rules     # seed + run AI rule drafting (uses OpenAI credits, ~40s)
```

> The seed script and fixtures under `fixtures/` are **dev-only** sample data, not production content.

## Decision / interview API

The engine is exposed for downstream consumers (such as the eligibility chatbot):

- `POST /rulesets/:id/interview-step` — body `{ answers }`; evaluates a published ruleset and returns either a final decision or the fields still needed.
- `POST /interview-step` — stateless; body `{ rules, captureSchema, answers }`. Lets a caller evaluate an already-merged base+overlay ruleset.

Each returns engine state: `{ status: "question" | "decision", outcome?, firedRules[], pendingFields[] }`.

## Repository layout

```
apps/
  api/        Fastify server: ingest, schema, rules, publish, interview
  web/        React review UI (sessions, schema, rules, coverage, audit log)
packages/
  schema/     Shared rule/condition/capture types
  compiler/   PDF text extraction + LLM schema & rule drafting
  engine/     Deterministic rule evaluation + interview state
fixtures/     Sample insurance PDFs for seeding (dev only)
scripts/      Dev seed script
```

Runtime data (uploaded documents, sessions, generated rulesets) is written under `apps/api/data/` and is gitignored.
