import { readFile, writeFile, readdir, mkdir, rm, rename } from "fs/promises";
import { fileURLToPath } from "url";
import { join } from "path";
import type { RulesetVersion } from "@workbench/schema";

const RULESETS_DIR = fileURLToPath(
  new URL("../../data/rulesets", import.meta.url)
);

async function ensureDir(): Promise<void> {
  await mkdir(RULESETS_DIR, { recursive: true });
}

// Slugify a product name into a filesystem-safe token: unify dash variants, lowercase,
// non-alphanumerics → "-", collapse and trim. "Term Life – California 2026 [DEV]" → "term-life-california-2026-dev"
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Human-readable, identifiable filename. Includes jurisdiction and a short id slice so it is
// unique; the canonical lookup key is still the full `id` field.
function rulesetFilename(r: RulesetVersion): string {
  const juris = slug(r.jurisdiction || "us");
  return `${slug(r.productName)}_${juris}_${r.effectiveDate}_${r.version}_${r.id.slice(0, 8)}.json`;
}

export async function saveRuleset(ruleset: RulesetVersion): Promise<void> {
  await ensureDir();
  const target = rulesetFilename(ruleset);

  // Remove any pre-existing file for this same ruleset id under a different name
  // (e.g. an older UUID-named file), so we never leave a duplicate behind.
  try {
    for (const file of await readdir(RULESETS_DIR)) {
      if (!file.endsWith(".json") || file === target) continue;
      try {
        const rs = JSON.parse(await readFile(join(RULESETS_DIR, file), "utf-8")) as RulesetVersion;
        if (rs.id === ruleset.id) await rm(join(RULESETS_DIR, file));
      } catch { /* skip unreadable */ }
    }
  } catch { /* best effort */ }

  await writeFile(join(RULESETS_DIR, target), JSON.stringify(ruleset, null, 2), "utf-8");
}

export async function getRuleset(id: string): Promise<RulesetVersion | null> {
  await ensureDir();

  // Fast path: legacy UUID-named files are exactly `${id}.json`.
  try {
    const legacy = await readFile(join(RULESETS_DIR, `${id}.json`), "utf-8");
    return JSON.parse(legacy) as RulesetVersion;
  } catch { /* fall through to content scan */ }

  // Descriptive filenames: resolve by the `id` field, independent of filename.
  try {
    for (const file of await readdir(RULESETS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const rs = JSON.parse(await readFile(join(RULESETS_DIR, file), "utf-8")) as RulesetVersion;
        if (rs.id === id) return rs;
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir missing */ }

  return null;
}

export async function listRulesets(): Promise<RulesetVersion[]> {
  await ensureDir();
  const files = await readdir(RULESETS_DIR);
  const rulesets: RulesetVersion[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await readFile(join(RULESETS_DIR, file), "utf-8");
      rulesets.push(JSON.parse(content) as RulesetVersion);
    } catch { /* skip corrupt */ }
  }
  return rulesets.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

// The latest published countrywide base ruleset for a product (used as context when
// drafting a state overlay). Picks the newest by effectiveDate, then version.
export async function getLatestBase(productName: string): Promise<RulesetVersion | null> {
  const all = await listRulesets();
  const bases = all
    .filter((r) => r.productName === productName && (r.jurisdiction || "US") === "US"
      && (r.kind || "base") === "base" && r.status === "published")
    .sort((a, b) => {
      const d = new Date(b.effectiveDate).getTime() - new Date(a.effectiveDate).getTime();
      if (d !== 0) return d;
      return Number(b.version.replace(/\D/g, "") || 0) - Number(a.version.replace(/\D/g, "") || 0);
    });
  return bases[0] ?? null;
}

export async function nextVersionNumber(productName: string, jurisdiction = "US"): Promise<number> {
  const all = await listRulesets();
  // Version independently per product + jurisdiction (CA overlays version separately from the US base).
  const matching = all.filter(
    (r) => r.productName === productName && (r.jurisdiction || "US") === jurisdiction,
  );
  return matching.length + 1;
}

// One-time, idempotent: rename any ruleset file whose name doesn't match the descriptive
// scheme (e.g. legacy `${id}.json`). Safe to run on every startup — a no-op once migrated.
export async function migrateRulesetFilenames(): Promise<void> {
  await ensureDir();
  let renamed = 0;
  try {
    for (const file of await readdir(RULESETS_DIR)) {
      if (!file.endsWith(".json")) continue;
      const full = join(RULESETS_DIR, file);
      try {
        const rs = JSON.parse(await readFile(full, "utf-8")) as RulesetVersion;
        // Backfill jurisdiction/kind on pre-overlay rulesets (treat them as the countrywide base).
        let mutated = false;
        if (!rs.jurisdiction) { rs.jurisdiction = "US"; mutated = true; }
        if (!rs.kind) { rs.kind = rs.jurisdiction === "US" ? "base" : "overlay"; mutated = true; }
        if (mutated) await writeFile(full, JSON.stringify(rs, null, 2), "utf-8");

        const target = rulesetFilename(rs);
        if (file !== target) {
          await rename(full, join(RULESETS_DIR, target));
          renamed++;
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir missing */ }
  if (renamed > 0) console.log(`Renamed ${renamed} ruleset file(s) to descriptive names`);
}
