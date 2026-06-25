import { useState } from "react";
import type { Session, CaptureField } from "@workbench/schema";

const DATATYPE_COLORS: Record<string, string> = {
  string: "bg-blue-900 text-blue-300",
  number: "bg-purple-900 text-purple-300",
  date: "bg-green-900 text-green-300",
  boolean: "bg-yellow-900 text-yellow-300",
  enum: "bg-orange-900 text-orange-300",
  currency: "bg-emerald-900 text-emerald-300",
  array: "bg-indigo-900 text-indigo-300",
};

const DATATYPES: CaptureField["datatype"][] = ["string", "number", "date", "boolean", "enum", "currency", "array"];

interface FieldCardProps {
  field: CaptureField;
  sessionId?: string;
  onSessionUpdate?: (s: Session) => void;
}

function FieldCard({ field, nested = false, sessionId, onSessionUpdate }: FieldCardProps & { nested?: boolean }) {
  const [itemsOpen, setItemsOpen] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [eLabel, setELabel] = useState(field.label);
  const [eSection, setESection] = useState(field.section);
  const [eDatatype, setEDatatype] = useState(field.datatype);
  const [eRequired, setERequired] = useState(field.required);
  const [eOptions, setEOptions] = useState((field.options ?? []).join(", "));

  const dtColor = DATATYPE_COLORS[field.datatype] ?? "bg-gray-800 text-gray-300";
  const isArray = field.datatype === "array";
  // Editing is only enabled for top-level fields (nested sub-fields edit via their parent's items).
  const editable = !nested && !!sessionId && !!onSessionUpdate;

  async function handleSaveEdit() {
    if (!sessionId || !onSessionUpdate) return;
    setIsSaving(true);
    setEditError("");
    try {
      const body: Record<string, unknown> = {
        label: eLabel,
        section: eSection,
        datatype: eDatatype,
        required: eRequired,
      };
      if (eDatatype === "enum") {
        body.options = eOptions.split(",").map((o) => o.trim()).filter(Boolean);
      }
      const res = await fetch(`/sessions/${sessionId}/schema/fields/${field.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as Session & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onSessionUpdate(data);
      setIsEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!sessionId || !onSessionUpdate) return;
    if (!confirm(`Delete field "${field.id}"? This is only allowed if no active rule references it.`)) return;
    setIsSaving(true);
    setEditError("");
    try {
      const res = await fetch(`/sessions/${sessionId}/schema/fields/${field.id}`, { method: "DELETE" });
      const data = await res.json() as Session & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onSessionUpdate(data);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  const provenanceBadge =
    field.provenance === "manual" ? <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-indigo-900 text-indigo-300">manual</span>
    : field.provenance === "edited" ? <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-yellow-900 text-yellow-300">edited</span>
    : null;

  return (
    <div className={`rounded-lg border bg-gray-900/60 p-4 space-y-2 ${nested ? "border-indigo-900/50" : "border-gray-800"}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <span className="font-semibold text-white">{field.label}</span>
          <span className="ml-2 font-mono text-xs text-gray-500">
            {field.id}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${dtColor}`}>
            {isArray ? `array${field.items ? ` · ${field.items.length} sub-fields` : ""}` : field.datatype}
          </span>
          {field.required && (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-red-900 text-red-300">
              required
            </span>
          )}
          {provenanceBadge}
          {field.source.document && field.provenance !== "manual" && (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-gray-700 text-gray-300 max-w-[160px] truncate" title={field.source.document}>
              {field.source.document}
            </span>
          )}
          {editable && !isEditing && (
            <>
              <button
                onClick={() => { setIsEditing(true); setELabel(field.label); setESection(field.section); setEDatatype(field.datatype); setERequired(field.required); setEOptions((field.options ?? []).join(", ")); setEditError(""); }}
                disabled={isSaving}
                className="p-1 rounded text-gray-500 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-50"
                title="Edit field"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                onClick={handleDelete}
                disabled={isSaving}
                className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                title="Delete field (only if unreferenced)"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Inline edit form */}
      {isEditing && (
        <div className="space-y-2 pt-1 pb-1">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Label</label>
              <input value={eLabel} onChange={(e) => setELabel(e.target.value)} className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-white text-xs focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Section</label>
              <input value={eSection} onChange={(e) => setESection(e.target.value)} className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-white text-xs focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Datatype</label>
              <select value={eDatatype} onChange={(e) => setEDatatype(e.target.value as CaptureField["datatype"])} className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-white text-xs focus:outline-none focus:border-blue-500">
                {DATATYPES.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-xs text-gray-400 pb-1">
                <input type="checkbox" checked={eRequired} onChange={(e) => setERequired(e.target.checked)} className="rounded" />
                Required
              </label>
            </div>
          </div>
          {eDatatype === "enum" && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Options (comma-separated)</label>
              <input value={eOptions} onChange={(e) => setEOptions(e.target.value)} className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-white text-xs focus:outline-none focus:border-blue-500" />
            </div>
          )}
          {editError && <p className="text-xs text-red-400 font-mono">{editError}</p>}
          <div className="flex items-center gap-2">
            <button onClick={handleSaveEdit} disabled={isSaving} className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium transition-colors">
              {isSaving ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setIsEditing(false)} className="px-3 py-1 rounded text-xs text-gray-400 hover:text-white transition-colors">Cancel</button>
          </div>
        </div>
      )}
      {!isEditing && editError && <p className="text-xs text-red-400 font-mono">{editError}</p>}

      {field.options && field.options.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {field.options.map((opt) => (
            <span key={opt} className="text-xs px-2 py-0.5 bg-gray-800 text-gray-300 rounded border border-gray-700">
              {opt}
            </span>
          ))}
        </div>
      )}

      {field.reflexiveTriggers && field.reflexiveTriggers.length > 0 && (
        <div className="mt-2 space-y-1">
          {field.reflexiveTriggers.map((trigger, i) => (
            <div key={i} className="text-xs text-gray-400">
              <span className="text-yellow-400 font-medium">When {trigger.when}:</span>{" "}
              reveals {trigger.reveal.join(", ")}
            </div>
          ))}
        </div>
      )}

      {field.source.excerpt && (
        <blockquote className="mt-2 border-l-2 border-gray-700 pl-3 text-xs text-gray-400 italic">
          {field.source.excerpt}
          {field.source.page && (
            <span className="ml-2 not-italic text-gray-600 font-mono">— p.{field.source.page}</span>
          )}
        </blockquote>
      )}

      {/* Nested items for array fields */}
      {isArray && field.items && field.items.length > 0 && (
        <div className="mt-3 pt-3 border-t border-indigo-900/40 space-y-2">
          <button
            onClick={() => setItemsOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-200 transition-colors"
          >
            <span className={`transition-transform text-indigo-600 ${itemsOpen ? "rotate-90" : ""}`}>▶</span>
            <span className="font-medium">Repeating item fields</span>
            <span className="text-indigo-600">({field.items.length})</span>
          </button>
          {itemsOpen && (
            <div className="space-y-2 pl-3 border-l border-indigo-900/40">
              {field.items.map((sub) => (
                <FieldCard key={sub.id} field={sub} nested />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface SectionGroupProps {
  section: string;
  fields: CaptureField[];
  sessionId?: string;
  onSessionUpdate?: (s: Session) => void;
}

function SectionGroup({ section, fields, sessionId, onSessionUpdate }: SectionGroupProps) {
  const [open, setOpen] = useState(true);

  return (
    <div className="mb-6">
      <button
        className="flex items-center gap-2 w-full text-left mb-3"
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={`transition-transform text-gray-500 text-xs ${open ? "rotate-90" : ""}`}
        >
          ▶
        </span>
        <span className="text-sm font-semibold uppercase tracking-wider text-gray-400">
          {section}
        </span>
        <span className="text-xs text-gray-600 ml-1">
          ({fields.length} field{fields.length !== 1 ? "s" : ""})
        </span>
      </button>

      {open && (
        <div className="space-y-3 pl-5">
          {fields.map((field) => (
            <FieldCard key={field.id} field={field} sessionId={sessionId} onSessionUpdate={onSessionUpdate} />
          ))}
        </div>
      )}
    </div>
  );
}

function AddFieldForm({ sessionId, onSessionUpdate, sections }: {
  sessionId: string;
  onSessionUpdate: (s: Session) => void;
  sections: string[];
}) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [section, setSection] = useState(sections[0] ?? "Manual");
  const [datatype, setDatatype] = useState<CaptureField["datatype"]>("string");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleAdd() {
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = { id, label, section, datatype, required };
      if (datatype === "enum") body.options = options.split(",").map((o) => o.trim()).filter(Boolean);
      const res = await fetch(`/sessions/${sessionId}/schema/fields`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as Session & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onSessionUpdate(data);
      setId(""); setLabel(""); setOptions(""); setRequired(false); setDatatype("string");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full px-3 py-2 rounded-lg border border-dashed border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white text-sm transition-colors"
      >
        + Add field
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-3">
      <p className="text-sm font-semibold text-white">Add a field</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Field ID (snake_case)</label>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="applicant_age" className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-white text-xs font-mono focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Label</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Applicant Age" className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-white text-xs focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Section</label>
          <input value={section} onChange={(e) => setSection(e.target.value)} list="section-list" className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-white text-xs focus:outline-none focus:border-blue-500" />
          <datalist id="section-list">{sections.map((s) => <option key={s} value={s} />)}</datalist>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Datatype</label>
          <select value={datatype} onChange={(e) => setDatatype(e.target.value as CaptureField["datatype"])} className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-white text-xs focus:outline-none focus:border-blue-500">
            {DATATYPES.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      </div>
      {datatype === "enum" && (
        <div>
          <label className="block text-xs text-gray-500 mb-1">Options (comma-separated)</label>
          <input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Yes, No, Unknown" className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-white text-xs focus:outline-none focus:border-blue-500" />
        </div>
      )}
      <label className="flex items-center gap-2 text-xs text-gray-400">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="rounded" />
        Required
      </label>
      {error && <p className="text-xs text-red-400 font-mono">{error}</p>}
      <div className="flex items-center gap-2">
        <button onClick={handleAdd} disabled={saving || !id || !label} className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium transition-colors">
          {saving ? "Adding…" : "Add field"}
        </button>
        <button onClick={() => { setOpen(false); setError(""); }} className="px-3 py-1 rounded text-xs text-gray-400 hover:text-white transition-colors">Cancel</button>
      </div>
    </div>
  );
}

interface SchemaViewerProps {
  session: Session;
  onSessionUpdate?: (s: Session) => void;
}

export default function SchemaViewer({ session, onSessionUpdate }: SchemaViewerProps) {
  const fields = session.captureSchema ?? [];
  const sessionId = onSessionUpdate ? session.id : undefined;

  // Group fields by section
  const sectionMap = new Map<string, CaptureField[]>();
  for (const field of fields) {
    const list = sectionMap.get(field.section) ?? [];
    list.push(field);
    sectionMap.set(field.section, list);
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">
            Merged Schema
          </h2>
          <p className="text-gray-400 text-sm mt-1">
            {fields.length} field{fields.length !== 1 ? "s" : ""} extracted
            across {sectionMap.size} section{sectionMap.size !== 1 ? "s" : ""}
            {(() => {
              const formDocs = session.documents.filter((d) => d.status === "ready" && d.fields.length > 0).length;
              return formDocs > 0 ? ` from ${formDocs} form${formDocs !== 1 ? "s" : ""}` : "";
            })()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded font-medium ${
            session.status === "ready"
              ? "bg-green-900 text-green-300"
              : session.status === "error"
              ? "bg-red-900 text-red-300"
              : session.status === "extracting"
              ? "bg-yellow-900 text-yellow-300"
              : "bg-gray-800 text-gray-300"
          }`}>
            {session.status}
          </span>
          <span className="text-xs text-gray-600 font-mono">
            {new Date(session.createdAt).toLocaleString()}
          </span>
        </div>
      </div>

      {fields.length === 0 ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-8 text-center text-gray-500">
            {session.status === "empty"
              ? "Add a document to extract fields."
              : "No fields were extracted from the uploaded documents."}
          </div>
          {onSessionUpdate && (
            <AddFieldForm sessionId={session.id} onSessionUpdate={onSessionUpdate} sections={[]} />
          )}
        </div>
      ) : (
        <div>
          {Array.from(sectionMap.entries()).map(([section, sectionFields]) => (
            <SectionGroup
              key={section}
              section={section}
              fields={sectionFields}
              sessionId={sessionId}
              onSessionUpdate={onSessionUpdate}
            />
          ))}
          {onSessionUpdate && (
            <div className="pl-5 mt-2">
              <AddFieldForm
                sessionId={session.id}
                onSessionUpdate={onSessionUpdate}
                sections={Array.from(sectionMap.keys())}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
