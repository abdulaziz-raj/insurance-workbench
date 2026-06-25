import { useRef, useState, useEffect } from "react";
import type { Session } from "@workbench/schema";
import { uploadDocumentStreaming } from "../api/uploadDocument";

interface UploadPanelProps {
  onSessionReady: (session: Session) => void;
}

type UploadState = "idle" | "uploading" | "extracting" | "error";

export default function UploadPanel({ onSessionReady }: UploadPanelProps) {
  const [productName, setProductName] = useState("");
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [fieldCount, setFieldCount] = useState(0);
  const [detected, setDetected] = useState<{ role: string; productName?: string; jurisdiction?: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ROLE_LABELS: Record<string, string> = {
    application_form: "Application Form",
    acord_form: "ACORD Form",
    guidelines: "Guidelines",
    state_addendum: "State Addendum",
    other: "Other",
  };

  // Tick an elapsed-seconds counter while extracting so the user can see it's still working.
  useEffect(() => {
    if (uploadState !== "uploading" && uploadState !== "extracting") {
      setElapsed(0);
      return;
    }
    setFieldCount(0);
    setDetected(null);
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [uploadState]);

  // Extraction of large forms can legitimately take ~2 minutes; abort past this so the
  // spinner can't appear to hang forever if the upstream model call stalls.
  const EXTRACT_TIMEOUT_MS = 240_000;

  // TODO: dev-only — remove before production
  const [devSessions, setDevSessions] = useState<Session[]>([]);
  const [devSelected, setDevSelected] = useState("");

  useEffect(() => {
    fetch("/sessions")
      .then((r) => r.json())
      .then((sessions: Session[]) => {
        const valid = sessions?.filter((s) => Array.isArray(s.documents) && s.documents.length > 0) ?? [];
        setDevSessions(valid);
        if (valid.length > 0) setDevSelected(valid[0].id);
      })
      .catch(() => {});
  }, []);

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setErrorMsg("Please upload a PDF file.");
      setUploadState("error");
      return;
    }

    setUploadState("uploading");
    setErrorMsg("");

    try {
      // Step 1: create the session
      const sessionRes = await fetch("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productName: productName.trim() || "Untitled Ruleset",
          // jurisdiction is auto-detected from the document on upload (server defaults to "US")
        }),
      });
      if (!sessionRes.ok) {
        const errBody = await sessionRes.text();
        throw new Error(`Failed to create session (${sessionRes.status}): ${errBody.slice(0, 200)}`);
      }
      const newSession = (await sessionRes.json()) as Session;

      // Step 2: upload the document, streaming live extraction progress.
      // role "auto" → the server classifies the document type and suggests a product name.
      setUploadState("extracting");

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
      let data: Session;
      try {
        data = await uploadDocumentStreaming(newSession.id, file, "auto", {
          signal: controller.signal,
          onProgress: (n) => setFieldCount(n),
          onClassified: (info) => setDetected(info),
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new Error("Extraction timed out after 4 minutes. The form may be very large or the AI service is slow — try again, or split the document.");
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      if (data.status === "error") {
        throw new Error(data.error || "Extraction failed");
      }

      onSessionReady(data);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setUploadState("error");
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  const isProcessing = uploadState === "uploading" || uploadState === "extracting";

  return (
    <div className="max-w-xl mx-auto mt-16">

      {/* TODO: dev-only quick-load — remove before production */}
      {devSessions.length > 0 && (
        <div className="mb-8 rounded-lg border border-dashed border-yellow-800 bg-yellow-950/20 p-4">
          <p className="text-xs font-semibold text-yellow-500 uppercase tracking-widest mb-3">
            Dev — quick load
          </p>
          <div className="flex gap-2">
            <select
              value={devSelected}
              onChange={(e) => setDevSelected(e.target.value)}
              className="flex-1 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-yellow-600"
            >
              {devSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.productName} ({s.documents.length} doc{s.documents.length !== 1 ? "s" : ""}
                  {s.rules ? `, ${s.rules.length} rules` : ""})
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                const s = devSessions.find((s) => s.id === devSelected);
                if (s) onSessionReady(s);
              }}
              className="px-4 py-2 rounded-lg bg-yellow-700 hover:bg-yellow-600 text-white text-sm font-medium transition-colors"
            >
              Load
            </button>
          </div>
        </div>
      )}

      <h2 className="text-xl font-semibold text-white mb-2">
        Upload Insurance Form
      </h2>
      <p className="text-gray-400 text-sm mb-6">
        Upload a PDF to extract its capture schema using AI. The document type is detected
        automatically, and a product name is suggested from the form — you can adjust both later.
      </p>

      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Product / Ruleset name <span className="text-gray-500 font-normal">(optional)</span>
        </label>
        <input
          type="text"
          value={productName}
          onChange={(e) => setProductName(e.target.value)}
          placeholder="Leave blank to auto-suggest from the document"
          disabled={isProcessing}
          className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
        />
      </div>

      <p className="text-xs text-gray-500 mb-4 -mt-1">
        Jurisdiction is detected from the document — upload a state addendum and this becomes a state overlay
        automatically. You can adjust it from the workspace header afterward.
      </p>

      <div
        className={`
          border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors
          ${isDragOver
            ? "border-blue-500 bg-blue-950/30"
            : "border-gray-700 bg-gray-900 hover:border-gray-600 hover:bg-gray-800/50"
          }
          ${isProcessing ? "pointer-events-none opacity-60" : ""}
        `}
        onClick={() => !isProcessing && fileInputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!isProcessing) fileInputRef.current?.click();
          }
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={handleInputChange}
        />

        {isProcessing ? (
          <div className="flex flex-col items-center gap-4">
            <span className="inline-block w-10 h-10 border-4 border-gray-600 border-t-blue-400 rounded-full animate-spin" />
            <div>
              <p className="text-white font-medium">
                {uploadState === "uploading"
                  ? "Creating session…"
                  : fieldCount > 0
                  ? `Extracting fields with AI… ${fieldCount} found`
                  : "Extracting fields with AI…"}
              </p>
              {detected && (
                <p className="text-blue-300 text-xs mt-1">
                  Detected: {ROLE_LABELS[detected.role] ?? detected.role}
                  {detected.productName ? ` · “${detected.productName}”` : ""}
                  {detected.jurisdiction && detected.jurisdiction.toUpperCase() !== "US"
                    ? ` · ${detected.jurisdiction} overlay`
                    : ""}
                </p>
              )}
              <p className="text-gray-400 text-sm mt-1">
                {uploadState === "extracting"
                  ? `Large forms can take 1–2 minutes — this is normal.${elapsed > 0 ? ` (${elapsed}s)` : ""}`
                  : "Just a moment…"}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="w-14 h-14 rounded-full bg-gray-800 flex items-center justify-center">
              <svg
                className="w-7 h-7 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
            </div>
            <div>
              <p className="text-white font-medium">
                Drop a PDF here, or{" "}
                <span className="text-blue-400 underline">browse</span>
              </p>
              <p className="text-gray-500 text-sm mt-1">PDF files only</p>
            </div>
          </div>
        )}
      </div>

      {uploadState === "error" && (
        <div className="mt-4 rounded-lg bg-red-950 border border-red-800 p-4">
          <p className="text-red-400 font-semibold text-sm mb-1">
            Upload failed
          </p>
          <p className="text-red-300 text-xs font-mono">{errorMsg}</p>
          <button
            className="mt-3 text-xs text-red-400 underline hover:text-red-300"
            onClick={() => setUploadState("idle")}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
