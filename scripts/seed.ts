// TODO: DEV-ONLY seed script — remove before production deployment
//
// Usage:
//   npm run seed               — upload fixtures, skip rule drafting
//   npm run seed -- --rules    — upload fixtures + run AI rule drafting (costs OpenAI credits, ~40s)
//
// Creates (or reuses) named dev sessions and uploads fixture PDFs from fixtures/.
// Re-running is safe: it checks for an existing session by productName and skips creation.

import { readFileSync, existsSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";

const API_BASE = "http://localhost:3001";
const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const WITH_RULES = process.argv.includes("--rules");

interface DocSpec {
  file: string;
  role: string;
}

interface ProductSpec {
  productName: string;
  docs: DocSpec[];
  draftRules: boolean;
}

const PRODUCTS: ProductSpec[] = [
  {
    productName: "Term Life – California 2026 [DEV]",
    draftRules: WITH_RULES,
    docs: [
      { file: "term_life_application.pdf", role: "application_form" },
      { file: "term_life_underwriting_guidelines.pdf", role: "guidelines" },
      { file: "notices_and_replacement.pdf", role: "other" },
      { file: "state_addendum_california.pdf", role: "state_addendum" },
    ],
  },
  {
    productName: "Commercial Property [DEV]",
    draftRules: false,
    docs: [
      { file: "commercial_property_application.pdf", role: "application_form" },
    ],
  },
];

async function getOrCreateSession(productName: string): Promise<string> {
  const listRes = await fetch(`${API_BASE}/sessions`);
  const sessions = (await listRes.json()) as { id: string; productName: string }[];
  const existing = sessions.find((s) => s.productName === productName);
  if (existing) {
    console.log(`  ↩  Reusing session ${existing.id} ("${productName}")`);
    return existing.id;
  }

  const createRes = await fetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productName }),
  });
  const session = (await createRes.json()) as { id: string };
  console.log(`  ✓  Created session ${session.id}`);
  return session.id;
}

async function uploadDoc(
  sessionId: string,
  filePath: string,
  role: string,
  existingDocNames: Set<string>,
): Promise<void> {
  const fileName = basename(filePath);

  if (existingDocNames.has(fileName)) {
    console.log(`  ↩  ${fileName} [${role}] — already uploaded`);
    return;
  }

  if (!existsSync(filePath)) {
    console.warn(`  ⚠  Skipping ${fileName} — file not found`);
    return;
  }

  const fileBuffer = readFileSync(filePath);
  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer], { type: "application/pdf" }), fileName);
  formData.append("role", role);

  const res = await fetch(`${API_BASE}/sessions/${sessionId}/documents`, {
    method: "POST",
    body: formData,
  });

  const data = (await res.json()) as { error?: string; documents?: { name: string; status: string; fields: unknown[] }[] };

  if (!res.ok) {
    console.warn(`  ⚠  ${fileName} [${role}] — error: ${data.error ?? res.status}`);
    return;
  }

  const doc = data.documents?.find((d) => d.name === fileName);
  const fieldCount = Array.isArray(doc?.fields) ? doc!.fields.length : 0;
  const status = doc?.status ?? "?";
  console.log(`  ✓  ${fileName} [${role}] — ${status}${fieldCount ? `, ${fieldCount} fields` : ""}`);
}

async function runDraftRules(sessionId: string): Promise<void> {
  console.log("  … Drafting rules (this takes ~40s)…");
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/draft-rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const data = (await res.json()) as { rules?: unknown[]; error?: string };
  if (!res.ok) {
    console.warn(`  ⚠  Rule drafting failed: ${data.error ?? res.status}`);
    return;
  }
  console.log(`  ✓  ${data.rules?.length ?? 0} rules drafted`);
}

async function seed(): Promise<void> {
  // Verify API is reachable
  try {
    await fetch(`${API_BASE}/health`);
  } catch {
    console.error(`✗  API server not reachable at ${API_BASE}. Start it first with: npm run dev`);
    process.exit(1);
  }

  for (const product of PRODUCTS) {
    console.log(`\n── ${product.productName}`);

    const sessionId = await getOrCreateSession(product.productName);

    // Fetch current session to know which docs are already uploaded
    const sessionRes = await fetch(`${API_BASE}/sessions/${sessionId}`);
    const session = (await sessionRes.json()) as { documents?: { name: string }[] };
    const existingDocNames = new Set((session.documents ?? []).map((d) => d.name));

    for (const doc of product.docs) {
      const filePath = resolve(FIXTURES_DIR, doc.file);
      await uploadDoc(sessionId, filePath, doc.role, existingDocNames);
    }

    if (product.draftRules) {
      await runDraftRules(sessionId);
    } else if (WITH_RULES === false) {
      console.log(`  ℹ  Skipping rule drafting (pass --rules to enable)`);
    }
  }

  console.log("\nDone. Open http://localhost:5173 to see the seeded sessions.\n");
}

void seed();
