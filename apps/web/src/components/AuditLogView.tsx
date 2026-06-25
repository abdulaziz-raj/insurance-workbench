import { useState } from "react";
import type { Session, AuditEntry, AuditAction } from "@workbench/schema";

interface AuditLogViewProps {
  session: Session;
}

const ACTION_META: Record<AuditAction, { label: string; color: string; icon: string }> = {
  document_uploaded:   { label: "Document",     color: "bg-blue-900 text-blue-300",     icon: "📄" },
  document_role_changed: { label: "Doc type",   color: "bg-blue-900 text-blue-300",     icon: "🏷" },
  session_renamed:     { label: "Renamed",      color: "bg-gray-700 text-gray-300",     icon: "✎" },
  schema_extracted:    { label: "Schema",       color: "bg-cyan-900 text-cyan-300",     icon: "🧩" },
  rules_drafted:       { label: "Drafted",      color: "bg-purple-900 text-purple-300", icon: "✨" },
  rule_status_changed: { label: "Review",       color: "bg-green-900 text-green-300",   icon: "✓" },
  rule_edited:         { label: "Edit",         color: "bg-gray-700 text-gray-300",     icon: "✎" },
  rule_logic_edited:   { label: "Logic edit",   color: "bg-orange-900 text-orange-300", icon: "⚙" },
  rule_corrected:      { label: "AI correct",   color: "bg-blue-900 text-blue-300",     icon: "🤖" },
  tests_run:           { label: "Tests",        color: "bg-gray-700 text-gray-300",     icon: "▶" },
  tests_fixed:         { label: "Tests fixed",  color: "bg-yellow-900 text-yellow-300", icon: "🔧" },
  ruleset_published:   { label: "Published",    color: "bg-green-700 text-green-200",   icon: "🚀" },
};

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const meta = ACTION_META[entry.action] ?? { label: entry.action, color: "bg-gray-800 text-gray-300", icon: "•" };
  const hasDetails = entry.details && Object.keys(entry.details).length > 0;

  return (
    <div className="border-b border-gray-800/60 last:border-b-0">
      <div className="flex items-start gap-3 py-3">
        <span className="text-sm mt-0.5 flex-shrink-0 w-5 text-center" aria-hidden>{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.color}`}>{meta.label}</span>
            <span className="text-sm text-white">{entry.summary}</span>
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
            <span>{new Date(entry.timestamp).toLocaleString()}</span>
            <span>·</span>
            <span className="font-mono">{entry.actor}</span>
            {entry.target && (<><span>·</span><span className="font-mono text-gray-600 truncate">{entry.target}</span></>)}
            {hasDetails && (
              <button onClick={() => setExpanded((v) => !v)} className="text-blue-400 hover:text-blue-300 ml-1">
                {expanded ? "hide" : "details"}
              </button>
            )}
          </div>
          {expanded && hasDetails && (
            <pre className="mt-2 p-2 rounded bg-gray-950 border border-gray-800 text-xs text-gray-400 font-mono overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(entry.details, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AuditLogView({ session }: AuditLogViewProps) {
  const [filter, setFilter] = useState<AuditAction | "all">("all");
  const log = session.auditLog ?? [];

  // Most recent first
  const sorted = [...log].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const filtered = filter === "all" ? sorted : sorted.filter((e) => e.action === filter);

  // Which action types actually appear, for the filter dropdown
  const presentActions = [...new Set(log.map((e) => e.action))] as AuditAction[];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Audit Log</h2>
          <p className="text-gray-400 text-sm mt-1">
            {log.length} event{log.length !== 1 ? "s" : ""} recorded for this session.
          </p>
        </div>
        {presentActions.length > 0 && (
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as AuditAction | "all")}
            className="px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-white text-xs focus:outline-none focus:border-blue-500"
          >
            <option value="all">All events ({log.length})</option>
            {presentActions.map((a) => (
              <option key={a} value={a}>{ACTION_META[a]?.label ?? a}</option>
            ))}
          </select>
        )}
      </div>

      {log.length === 0 ? (
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-8 text-center text-gray-500 text-sm">
          No activity recorded yet. Actions like drafting, reviewing, editing, and publishing will appear here.
        </div>
      ) : (
        <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-4">
          {filtered.map((entry) => <AuditRow key={entry.id} entry={entry} />)}
          {filtered.length === 0 && (
            <p className="py-6 text-center text-gray-600 text-sm">No events of this type.</p>
          )}
        </div>
      )}
    </div>
  );
}
