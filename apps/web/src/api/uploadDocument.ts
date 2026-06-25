import type { Session } from "@workbench/schema";

interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (fieldCount: number) => void;
  /** Fired once the server has classified the document (auto-detected role, name, jurisdiction). */
  onClassified?: (info: { role: string; productName?: string; jurisdiction?: string }) => void;
}

/**
 * Upload a document and stream extraction progress (NDJSON from the API).
 * Pass role "auto" to let the server detect the document type. Calls onProgress with a
 * running field count, onClassified when the role is detected, and resolves with the
 * final Session once extraction completes.
 */
export async function uploadDocumentStreaming(
  sessionId: string,
  file: File,
  role: string,
  opts: UploadOptions = {},
): Promise<Session> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("role", role);

  const res = await fetch(`/sessions/${sessionId}/documents?stream=1`, {
    method: "POST",
    body: formData,
    headers: { Accept: "application/x-ndjson" },
    signal: opts.signal,
  });

  // A pre-stream failure (e.g. 404 session not found) comes back as JSON, not NDJSON.
  if (!res.ok || !res.body) {
    const text = await res.text();
    let msg = `HTTP ${res.status}`;
    try { msg = (JSON.parse(text) as { error?: string }).error ?? msg; } catch { /* keep msg */ }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalSession: Session | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as {
        type: "progress" | "done" | "error" | "classified";
        fields?: number;
        session?: Session;
        error?: string;
        role?: string;
        productName?: string;
        jurisdiction?: string;
      };
      if (msg.type === "classified") {
        opts.onClassified?.({ role: msg.role ?? "other", productName: msg.productName, jurisdiction: msg.jurisdiction });
      } else if (msg.type === "progress" && typeof msg.fields === "number") {
        opts.onProgress?.(msg.fields);
      } else if (msg.type === "done" && msg.session) {
        finalSession = msg.session;
      } else if (msg.type === "error") {
        throw new Error(msg.error ?? "Extraction failed");
      }
    }
  }

  if (!finalSession) throw new Error("Extraction stream ended without a result");
  return finalSession;
}
