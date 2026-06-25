import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { fileURLToPath } from "url";
import { join } from "path";
import type { Session } from "@workbench/schema";

const DATA_DIR = fileURLToPath(
  new URL("../../data/sessions", import.meta.url)
);

async function ensureDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function saveSession(session: Session): Promise<void> {
  await ensureDir();
  const filePath = join(DATA_DIR, `${session.id}.json`);
  await writeFile(filePath, JSON.stringify(session, null, 2), "utf-8");
}

export async function getSession(id: string): Promise<Session | null> {
  await ensureDir();
  const filePath = join(DATA_DIR, `${id}.json`);
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as Session;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<Session[]> {
  await ensureDir();
  const files = await readdir(DATA_DIR);
  const sessions: Session[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await readFile(join(DATA_DIR, file), "utf-8");
      sessions.push(JSON.parse(content) as Session);
    } catch {
      // Skip corrupt files
    }
  }
  return sessions.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
