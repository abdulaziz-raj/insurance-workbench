import { useRef, useState, useEffect } from "react";
import type { Session, DocumentEntry, DocumentRole } from "@workbench/schema";
import SchemaViewer from "./SchemaViewer";
import { uploadDocumentStreaming } from "../api/uploadDocument";

const ROLE_LABELS: Record<DocumentRole, string> = {
  application_form: "Application Form",
  acord_form: "ACORD Form",
  guidelines: "Guidelines",
  state_addendum: "State Addendum",
  other: "Other",
};

// Roles whose fields build the capture schema; the rest are rule-drafting sources only.
const SCHEMA_ROLES: DocumentRole[] = ["application_form", "acord_form"];

const ROLE_BADGE_COLORS: Record<DocumentRole, string> = {
  application_form: "bg-blue-900 text-blue-300",
  acord_form: "bg-purple-900 text-purple-300",
  guidelines: "bg-green-900 text-green-300",
  state_addendum: "bg-orange-900 text-orange-300",
  other: "bg-gray-800 text-gray-300",
};

const STATUS_BADGE_COLORS: Record<DocumentEntry["status"], string> = {
  extracting: "bg-yellow-900 text-yellow-300",
  ready: "bg-green-900 text-green-300",
  error: "bg-red-900 text-red-300",
};

interface SessionWorkspaceProps {
  session: Session;
  onSessionUpdate: (s: Session) => void;
  onDraftRules: () => void;
  isDrafting: boolean;
}

export default function SessionWorkspace({
  session,
  onSessionUpdate,
  onDraftRules,
  isDrafting,
}: SessionWorkspaceProps) {
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [addRole, setAddRole] = useState<DocumentRole | "auto">("auto");
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>("");
  const [elapsed, setElapsed] = useState(0);
  const [fieldCount, setFieldCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Inline product-name editing
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(session.productName);
  const [savingName, setSavingName] = useState(false);
  // Inline jurisdiction editing
  const [editingJuris, setEditingJuris] = useState(false);
  const [jurisDraft, setJurisDraft] = useState(session.jurisdiction || "US");
  const [savingJuris, setSavingJuris] = useState(false);

  async function saveProductName() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === session.productName) { setEditingName(false); return; }
    setSavingName(true);
    try {
      const res = await fetch(`/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productName: trimmed }),
      });
      const data = await res.json() as Session & { error?: string };
      if (res.ok) onSessionUpdate(data);
    } finally {
      setSavingName(false);
      setEditingName(false);
    }
  }

  async function saveJurisdiction() {
    const trimmed = jurisDraft.trim() || "US";
    if (trimmed === (session.jurisdiction || "US")) { setEditingJuris(false); return; }
    setSavingJuris(true);
    try {
      const res = await fetch(`/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jurisdiction: trimmed }),
      });
      const data = await res.json() as Session & { error?: string };
      if (res.ok) onSessionUpdate(data);
    } finally {
      setSavingJuris(false);
      setEditingJuris(false);
    }
  }

  async function changeDocRole(docId: string, role: DocumentRole) {
    const res = await fetch(`/sessions/${session.id}/documents/${docId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const data = await res.json() as Session & { error?: string };
    if (res.ok) onSessionUpdate(data);
  }

  const EXTRACT_TIMEOUT_MS = 240_000;

  useEffect(() => {
    if (!isUploading) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [isUploading]);

  const sessionStatus = session.status;

  async function handleAddFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setUploadError("Please upload a PDF file.");
      return;
    }

    setIsUploading(true);
    setUploadError("");
    setFieldCount(0);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
    try {
      const data = await uploadDocumentStreaming(session.id, file, addRole, {
        signal: controller.signal,
        onProgress: (n) => setFieldCount(n),
      });
      if (data.status === "error") {
        throw new Error(data.error || "Extraction failed");
      }
      onSessionUpdate(data);
      setShowAddDoc(false);
      setAddRole("auto");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setUploadError("Extraction timed out after 4 minutes. The form may be very large or the AI service is slow — try again, or split the document.");
      } else {
        setUploadError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      clearTimeout(timeoutId);
      setIsUploading(false);
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void handleAddFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleAddFile(file);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          {editingName ? (
            <div className="flex items-center gap-2">
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") void saveProductName(); if (e.key === "Escape") setEditingName(false); }}
                disabled={savingName}
                className="text-2xl font-bold bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
              />
              <button onClick={() => void saveProductName()} disabled={savingName} className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
                {savingName ? "Saving…" : "Save"}
              </button>
              <button onClick={() => setEditingName(false)} className="text-xs px-2 py-1 rounded text-gray-400 hover:text-white">Cancel</button>
            </div>
          ) : (
            <h1 className="text-2xl font-bold text-white group flex items-center gap-2">
              {session.productName}
              <button
                onClick={() => { setNameDraft(session.productName); setEditingName(true); }}
                className="text-gray-600 hover:text-white transition-colors"
                title="Rename product / ruleset"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
            </h1>
          )}
          <div className="flex items-center gap-2 mt-1.5">
            {(() => {
              const juris = session.jurisdiction || "US";
              const isBase = juris.toUpperCase() === "US";
              return editingJuris ? (
                <span className="flex items-center gap-1.5">
                  <input
                    value={jurisDraft}
                    onChange={(e) => setJurisDraft(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter") void saveJurisdiction(); if (e.key === "Escape") setEditingJuris(false); }}
                    disabled={savingJuris}
                    className="w-28 text-xs bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
                  />
                  <button onClick={() => void saveJurisdiction()} disabled={savingJuris} className="text-xs px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
                    {savingJuris ? "…" : "Save"}
                  </button>
                  <button onClick={() => setEditingJuris(false)} className="text-xs text-gray-400 hover:text-white">Cancel</button>
                </span>
              ) : (
                <button
                  onClick={() => { setJurisDraft(juris); setEditingJuris(true); }}
                  title="Set jurisdiction — US = countrywide base, a state = overlay"
                  className={`text-xs px-2 py-0.5 rounded-full font-medium transition-colors ${isBase ? "bg-gray-700 text-gray-300 hover:bg-gray-600" : "bg-orange-900 text-orange-300 hover:bg-orange-800"}`}
                >
                  {isBase ? "Countrywide (US) · base" : `${juris} · overlay`}
                </button>
              );
            })()}
          </div>
          <p className="text-gray-400 text-sm mt-1">
            Created {new Date(session.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {session.captureSchema.length > 0 && (
            <button
              onClick={onDraftRules}
              disabled={isDrafting}
              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors flex items-center gap-2"
            >
              {isDrafting && (
                <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
              )}
              {isDrafting ? "Drafting…" : "Draft Rules"}
            </button>
          )}
          {(() => {
            const hasRules = (session.rules?.length ?? 0) > 0;
            let label: string;
            let cls: string;
            if (sessionStatus === "extracting") { label = "extracting…"; cls = "bg-yellow-900 text-yellow-300"; }
            else if (sessionStatus === "error") { label = "error"; cls = "bg-red-900 text-red-300"; }
            else if (sessionStatus === "empty") { label = "no documents"; cls = "bg-gray-800 text-gray-300"; }
            else if (hasRules) { label = `${session.rules!.length} rules drafted`; cls = "bg-green-900 text-green-300"; }
            else { label = "schema ready · rules not drafted"; cls = "bg-orange-900 text-orange-300"; }
            return <span className={`text-xs px-2 py-1 rounded font-medium ${cls}`}>{label}</span>;
          })()}
        </div>
      </div>

      <div className="flex gap-8 items-start">
        {/* Documents panel */}
        <div className="w-72 flex-shrink-0">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-3">
            Documents
          </h2>

          {(() => {
            const renderDoc = (doc: DocumentEntry) => {
              const isSchemaSource = SCHEMA_ROLES.includes(doc.role);
              return (
                <div key={doc.id} className="rounded-lg border border-gray-800 bg-gray-900/60 p-3 space-y-1">
                  <p className="text-sm font-medium text-white truncate" title={doc.name}>{doc.name}</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <select
                      value={doc.role}
                      onChange={(e) => void changeDocRole(doc.id, e.target.value as DocumentRole)}
                      title="Document type (auto-detected — change if wrong)"
                      className={`text-xs px-1.5 py-0.5 rounded-full font-medium border-0 focus:outline-none cursor-pointer ${ROLE_BADGE_COLORS[doc.role]}`}
                    >
                      {(Object.keys(ROLE_LABELS) as DocumentRole[]).map((r) => (
                        <option key={r} value={r} className="bg-gray-800 text-white">{ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE_COLORS[doc.status]}`}>
                      {doc.status === "extracting" ? (
                        <span className="flex items-center gap-1">
                          <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          extracting
                        </span>
                      ) : (doc.status)}
                    </span>
                  </div>
                  {doc.status === "ready" && (
                    <p className="text-xs text-gray-500">
                      {isSchemaSource
                        ? `${doc.fields.length} field${doc.fields.length !== 1 ? "s" : ""}`
                        : "rule-drafting source"}
                    </p>
                  )}
                  {doc.status === "error" && doc.error && (
                    <p className="text-xs text-red-400 font-mono truncate" title={doc.error}>{doc.error}</p>
                  )}
                </div>
              );
            };

            const schemaDocs = session.documents.filter((d) => SCHEMA_ROLES.includes(d.role));
            const ruleDocs = session.documents.filter((d) => !SCHEMA_ROLES.includes(d.role));

            if (session.documents.length === 0) {
              return <p className="text-gray-600 text-sm">No documents yet.</p>;
            }

            return (
              <div className="space-y-5">
                {schemaDocs.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-400/90">Schema sources</p>
                    <p className="text-[11px] text-gray-600 mb-2">Forms that define the fields to capture</p>
                    <div className="space-y-2">{schemaDocs.map(renderDoc)}</div>
                  </div>
                )}
                {ruleDocs.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-green-400/90">Rule sources</p>
                    <p className="text-[11px] text-gray-600 mb-2">Guidelines &amp; notices used to draft rules</p>
                    <div className="space-y-2">{ruleDocs.map(renderDoc)}</div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Add document */}
          {!showAddDoc ? (
            <button
              onClick={() => setShowAddDoc(true)}
              className="mt-3 w-full px-3 py-2 rounded-lg border border-dashed border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white text-sm transition-colors"
            >
              + Add document
            </button>
          ) : (
            <div className="mt-3 rounded-lg border border-gray-700 bg-gray-900 p-3 space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  Document type
                </label>
                <select
                  value={addRole}
                  onChange={(e) => setAddRole(e.target.value as DocumentRole | "auto")}
                  disabled={isUploading}
                  className="w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
                >
                  <option value="auto">Auto-detect (recommended)</option>
                  {(Object.keys(ROLE_LABELS) as DocumentRole[]).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>

              <div
                className={`
                  border border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors text-sm
                  ${isDragOver
                    ? "border-blue-500 bg-blue-950/30"
                    : "border-gray-700 hover:border-gray-500"
                  }
                  ${isUploading ? "pointer-events-none opacity-60" : ""}
                `}
                onClick={() => !isUploading && fileInputRef.current?.click()}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (!isUploading) fileInputRef.current?.click();
                  }
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onChange={handleFileInputChange}
                />
                {isUploading ? (
                  <div className="flex flex-col items-center gap-2">
                    <span className="inline-block w-6 h-6 border-2 border-gray-600 border-t-blue-400 rounded-full animate-spin" />
                    <p className="text-gray-400 text-xs">
                      {fieldCount > 0 ? `Extracting… ${fieldCount} fields found` : "Extracting fields…"}{elapsed > 0 ? ` (${elapsed}s)` : ""}
                    </p>
                    <p className="text-gray-600 text-[11px]">Large forms can take 1–2 minutes</p>
                  </div>
                ) : (
                  <p className="text-gray-400">
                    Drop PDF or{" "}
                    <span className="text-blue-400 underline">browse</span>
                  </p>
                )}
              </div>

              {uploadError && (
                <p className="text-xs text-red-400 font-mono">{uploadError}</p>
              )}

              <button
                onClick={() => {
                  setShowAddDoc(false);
                  setUploadError("");
                }}
                className="text-xs text-gray-500 hover:text-gray-300 underline"
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {/* Schema viewer */}
        <div className="flex-1 min-w-0">
          <SchemaViewer session={session} onSessionUpdate={onSessionUpdate} />
        </div>
      </div>
    </div>
  );
}
