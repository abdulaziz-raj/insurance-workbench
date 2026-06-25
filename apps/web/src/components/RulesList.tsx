import { useState, useEffect } from "react";
import type { Session, Rule, RuleType, Confidence, ReviewStatus, RulesetVersion } from "@workbench/schema";

interface RulesListProps {
  session: Session;
  onSessionUpdate: (s: Session) => void;
  onDraftRules: () => void;
  isDrafting: boolean;
}

const TYPE_BADGE: Record<RuleType, string> = {
  knockout: "bg-red-900 text-red-300",
  eligibility: "bg-orange-900 text-orange-300",
  disclosure: "bg-blue-900 text-blue-300",
  validation: "bg-gray-800 text-gray-300",
  rating_placeholder: "bg-purple-900 text-purple-300",
};

const CONFIDENCE_BADGE: Record<Confidence, string> = {
  high: "bg-green-900 text-green-300",
  medium: "bg-yellow-900 text-yellow-300",
  low: "bg-red-900 text-red-300",
};

const STATUS_LEFT_BORDER: Record<ReviewStatus, string> = {
  draft: "border-l-gray-700",
  approved: "border-l-green-500",
  rejected: "border-l-red-500",
  needs_review: "border-l-yellow-500",
};

const STATUS_BADGE: Record<ReviewStatus, string> = {
  draft: "bg-gray-800 text-gray-400",
  approved: "bg-green-900 text-green-300",
  rejected: "bg-red-900 text-red-300",
  needs_review: "bg-yellow-900 text-yellow-300",
};

const STATUS_LABEL: Record<ReviewStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  rejected: "Rejected",
  needs_review: "Needs Review",
};

function ReviewProgress({
  rules,
  onApproveHighConfidence,
  sessionId,
  onSessionUpdate,
}: {
  rules: Rule[];
  onApproveHighConfidence: () => void;
  sessionId: string;
  onSessionUpdate: (s: Session) => void;
}) {
  const [isPublishing, setIsPublishing] = useState(false);
  const [isRunningTests, setIsRunningTests] = useState(false);
  const [isFixingTests, setIsFixingTests] = useState(false);
  const [published, setPublished] = useState<RulesetVersion[] | null>(null);
  const [publishError, setPublishError] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));

  const total = rules.length;
  const approved = rules.filter((r) => r.status === "approved").length;
  const rejected = rules.filter((r) => r.status === "rejected").length;
  const needsReview = rules.filter((r) => r.status === "needs_review").length;
  const draft = rules.filter((r) => r.status === "draft").length;
  const decided = approved + rejected;
  const allDecided = draft === 0 && needsReview === 0;

  async function handlePublish() {
    setIsPublishing(true);
    setPublishError("");
    try {
      const res = await fetch(`/sessions/${sessionId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effectiveDate }),
      });
      const data = await res.json() as { published?: RulesetVersion[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPublished(data.published ?? []);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsPublishing(false);
    }
  }

  if (published) {
    return (
      <div className="rounded-lg border border-green-700 bg-green-950/30 p-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-green-600 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className="text-green-300 font-semibold text-sm">
              Published {published.length} ruleset{published.length !== 1 ? "s" : ""}
            </p>
            <p className="text-green-400/70 text-xs">
              {published[0]?.productName} · effective {published[0]?.effectiveDate}
            </p>
          </div>
        </div>
        <div className="space-y-2">
          {published.map((rs) => (
            <div key={rs.id} className="rounded bg-gray-900 border border-gray-800 p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${rs.kind === "base" ? "bg-gray-700 text-gray-300" : "bg-orange-900 text-orange-300"}`}>
                  {rs.kind === "base" ? "Countrywide (US) · base" : `${rs.jurisdiction} · overlay`}
                </span>
                <span className="text-xs text-gray-400">{rs.version} · {rs.rules.length} rules{rs.disabledBaseRuleIds?.length ? ` · ${rs.disabledBaseRuleIds.length} base removed` : ""}</span>
              </div>
              <p className="text-xs font-mono text-blue-400">GET /rulesets/{rs.id}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-semibold text-white">
            {decided}/{total} reviewed
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-900 text-green-300 font-medium">
            {approved} approved
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-red-900 text-red-300 font-medium">
            {rejected} rejected
          </span>
          {needsReview > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-900 text-yellow-300 font-medium">
              {needsReview} needs review
            </span>
          )}
          {draft > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 font-medium">
              {draft} draft
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {draft > 0 && (
            <button
              onClick={onApproveHighConfidence}
              className="px-3 py-1.5 rounded text-xs font-medium bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
              title="Approve all rules with high confidence that are still in draft"
            >
              Approve all high-confidence
            </button>
          )}
          <button
            onClick={async () => {
              setIsRunningTests(true);
              try {
                const res = await fetch(`/sessions/${sessionId}/run-tests`, {
                  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
                });
                const data = await res.json() as Session;
                onSessionUpdate(data);
              } finally {
                setIsRunningTests(false);
              }
            }}
            disabled={isRunningTests || isFixingTests || rules.length === 0}
            className="px-3 py-1.5 rounded text-xs font-medium bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {isRunningTests && <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />}
            {isRunningTests ? "Running…" : "Run Tests"}
          </button>
          <button
            onClick={async () => {
              setIsFixingTests(true);
              try {
                const res = await fetch(`/sessions/${sessionId}/fix-tests`, {
                  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
                });
                const data = await res.json() as Session;
                onSessionUpdate(data);
              } finally {
                setIsFixingTests(false);
              }
            }}
            disabled={isRunningTests || isFixingTests || rules.length === 0}
            title="Re-derive test expected actions from the engine. Fixes LLM-generated tests where expected.action is wrong. Rules with unknown field IDs are flagged for review."
            className="px-3 py-1.5 rounded text-xs font-medium bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {isFixingTests && <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />}
            {isFixingTests ? "Fixing…" : "Fix Tests"}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-gray-400" title="When this ruleset comes into force. The decision engine picks the in-force ruleset by this date.">
            <span>Effective</span>
            <input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-white text-xs focus:outline-none focus:border-blue-500"
            />
          </label>
          <button
            onClick={handlePublish}
            disabled={!allDecided || approved === 0 || isPublishing}
            className={`px-4 py-1.5 rounded text-sm font-medium transition-colors flex items-center gap-2 ${
              allDecided && approved > 0 && !isPublishing
                ? "bg-green-600 hover:bg-green-500 text-white"
                : "bg-gray-800 text-gray-600 cursor-not-allowed"
            }`}
            title={
              !allDecided
                ? `${draft + needsReview} rule${draft + needsReview !== 1 ? "s" : ""} still need a decision`
                : approved === 0
                ? "At least one rule must be approved"
                : undefined
            }
          >
            {isPublishing && (
              <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            )}
            {isPublishing ? "Publishing…" : "Proceed to Publish"}
          </button>
        </div>
      </div>
      {publishError && (
        <p className="text-xs text-red-400 font-mono">{publishError}</p>
      )}

      {/* Progress bar */}
      <div className="w-full h-1.5 rounded-full bg-gray-800 overflow-hidden">
        <div className="h-full flex">
          <div
            className="bg-green-500 transition-all duration-300"
            style={{ width: `${(approved / total) * 100}%` }}
          />
          <div
            className="bg-red-500 transition-all duration-300"
            style={{ width: `${(rejected / total) * 100}%` }}
          />
          <div
            className="bg-yellow-500 transition-all duration-300"
            style={{ width: `${(needsReview / total) * 100}%` }}
          />
        </div>
      </div>

      {(() => {
        const tested = rules.filter((r) => r.testStatus !== "untested");
        if (tested.length === 0) return null;
        const passing = tested.filter((r) => r.testStatus === "pass").length;
        const allPass = passing === tested.length;
        return (
          <p className={`text-xs font-medium ${allPass ? "text-green-400" : "text-red-400"}`}>
            {passing}/{tested.length} rules passing tests
          </p>
        );
      })()}
    </div>
  );
}

function RuleCard({
  rule,
  sessionId,
  onUpdate,
  schemaFieldIds,
}: {
  rule: Rule;
  sessionId: string;
  onUpdate: (updated: Session) => void;
  schemaFieldIds: Set<string>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editDescription, setEditDescription] = useState(rule.description);
  const [editConfidence, setEditConfidence] = useState<Confidence>(rule.confidence);
  const [editNotes, setEditNotes] = useState(rule.notes ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // AI correction
  const [correctionText, setCorrectionText] = useState("");
  const [isCorrecting, setIsCorrecting] = useState(false);
  const [correctionError, setCorrectionError] = useState("");
  // JSON editor
  const [showJsonEditor, setShowJsonEditor] = useState(false);
  const [jsonWhen, setJsonWhen] = useState(() => JSON.stringify(rule.when, null, 2));
  const [jsonThen, setJsonThen] = useState(() => JSON.stringify(rule.then, null, 2));
  const [jsonInputs, setJsonInputs] = useState(() => JSON.stringify(rule.inputs, null, 2));
  const [jsonError, setJsonError] = useState("");

  const isRejected = rule.status === "rejected";
  const unknownFields = rule.inputs.filter((id) => !schemaFieldIds.has(id));

  // Keep JSON editor in sync when the rule is updated from outside (e.g. after AI correction)
  useEffect(() => {
    if (!showJsonEditor) {
      setJsonWhen(JSON.stringify(rule.when, null, 2));
      setJsonThen(JSON.stringify(rule.then, null, 2));
      setJsonInputs(JSON.stringify(rule.inputs, null, 2));
    }
  }, [rule.when, rule.then, rule.inputs]);

  async function patchRule(patch: Partial<Pick<Rule, "status" | "description" | "confidence" | "notes" | "when" | "then" | "inputs">>) {
    setIsSaving(true);
    try {
      const res = await fetch(`/sessions/${sessionId}/rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json() as Session;
      onUpdate(data);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSaveEdit() {
    await patchRule({ description: editDescription, confidence: editConfidence, notes: editNotes || undefined });
    setIsEditing(false);
  }

  async function handleAiCorrection() {
    if (!correctionText.trim()) return;
    setIsCorrecting(true);
    setCorrectionError("");
    try {
      const res = await fetch(`/sessions/${sessionId}/rules/${rule.id}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: correctionText }),
      });
      const data = await res.json() as Session & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onUpdate(data);
      setCorrectionText("");
    } catch (err) {
      setCorrectionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCorrecting(false);
    }
  }

  async function handleSaveJson() {
    setJsonError("");
    let when, then, inputs;
    try { when = JSON.parse(jsonWhen); } catch { setJsonError("Invalid JSON in Condition (when)"); return; }
    try { then = JSON.parse(jsonThen); } catch { setJsonError("Invalid JSON in Outcome (then)"); return; }
    try { inputs = JSON.parse(jsonInputs); } catch { setJsonError("Invalid JSON in Inputs"); return; }
    if (!Array.isArray(inputs)) { setJsonError("inputs must be a JSON array"); return; }
    await patchRule({ when, then, inputs } as Parameters<typeof patchRule>[0]);
    setShowJsonEditor(false);
  }

  return (
    <div
      className={`rounded-lg border border-l-4 bg-gray-900/60 transition-opacity ${STATUS_LEFT_BORDER[rule.status]} ${isRejected ? "opacity-50" : ""}`}
    >
      {/* Header row */}
      <div className="p-4 space-y-2">
        <div className="flex items-start gap-2 flex-wrap">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${TYPE_BADGE[rule.type] ?? "bg-gray-800 text-gray-300"}`}>
            {rule.type}
          </span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${CONFIDENCE_BADGE[rule.confidence] ?? "bg-gray-800 text-gray-300"}`}>
            {rule.confidence}
          </span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${STATUS_BADGE[rule.status]}`}>
            {STATUS_LABEL[rule.status]}
          </span>
          {rule.testStatus !== "untested" && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${rule.testStatus === "pass" ? "bg-green-900 text-green-300" : "bg-red-900 text-red-300"}`}>
              {rule.testStatus === "pass" ? "tests pass" : "tests fail"}
            </span>
          )}
          {unknownFields.length > 0 && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 bg-orange-900 text-orange-300"
              title={`These input IDs are not in the capture schema: ${unknownFields.join(", ")}`}
            >
              unknown fields
            </span>
          )}

          {/* Action buttons */}
          <div className="ml-auto flex items-center gap-1 flex-shrink-0">
            {!isEditing && (
              <button
                onClick={() => { setIsEditing(true); setEditDescription(rule.description); setEditConfidence(rule.confidence); setEditNotes(rule.notes ?? ""); }}
                disabled={isSaving}
                className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-50"
                title="Edit rule"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
            )}
            <button
              onClick={() => patchRule({ status: "needs_review" })}
              disabled={isSaving || rule.status === "needs_review"}
              className={`p-1.5 rounded transition-colors disabled:opacity-50 ${rule.status === "needs_review" ? "text-yellow-400 bg-yellow-900/30" : "text-gray-500 hover:text-yellow-400 hover:bg-yellow-900/30"}`}
              title="Flag for review"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9" />
              </svg>
            </button>
            <button
              onClick={() => patchRule({ status: "rejected" })}
              disabled={isSaving || rule.status === "rejected"}
              className={`p-1.5 rounded transition-colors disabled:opacity-50 ${rule.status === "rejected" ? "text-red-400 bg-red-900/30" : "text-gray-500 hover:text-red-400 hover:bg-red-900/30"}`}
              title="Reject rule"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <button
              onClick={() => patchRule({ status: "approved" })}
              disabled={isSaving || rule.status === "approved"}
              className={`p-1.5 rounded transition-colors disabled:opacity-50 ${rule.status === "approved" ? "text-green-400 bg-green-900/30" : "text-gray-500 hover:text-green-400 hover:bg-green-900/30"}`}
              title="Approve rule"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </button>
          </div>
        </div>

        {/* Description + edit form */}
        {isEditing ? (
          <div className="space-y-2 pt-1">
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-600 text-white text-sm focus:outline-none focus:border-blue-500 resize-none"
            />
            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-400 flex-shrink-0">Confidence</label>
              <select
                value={editConfidence}
                onChange={(e) => setEditConfidence(e.target.value as Confidence)}
                className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-white text-xs focus:outline-none focus:border-blue-500"
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
            <textarea
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              rows={2}
              placeholder="Reviewer notes (optional)…"
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-600 text-gray-300 text-xs focus:outline-none focus:border-blue-500 resize-none placeholder-gray-600"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveEdit}
                disabled={isSaving}
                className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors disabled:opacity-50"
              >
                {isSaving ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => setIsEditing(false)}
                className="px-3 py-1 rounded text-xs text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm font-semibold text-white">{rule.description}</p>
        )}

        <p className="text-xs text-gray-500 font-mono">{rule.id}</p>

        {rule.notes && !isEditing && (
          <p className="text-xs text-yellow-300/70 italic">Note: {rule.notes}</p>
        )}
      </div>

      {/* Expand/collapse detail */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-1.5 flex items-center gap-2 text-xs text-gray-500 hover:text-gray-300 border-t border-gray-800/60 transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        {expanded ? "Hide details" : "Show inputs, source & tests"}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-800/60 pt-3">
          {/* Inputs */}
          {rule.inputs.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Inputs</p>
              <div className="flex flex-wrap gap-1">
                {rule.inputs.map((fieldId) => {
                  const isUnknown = !schemaFieldIds.has(fieldId);
                  return (
                    <span
                      key={fieldId}
                      className={`text-xs font-mono px-1.5 py-0.5 rounded border ${isUnknown ? "bg-orange-950 text-orange-300 border-orange-800" : "bg-gray-800 text-gray-400 border-gray-700"}`}
                      title={isUnknown ? "Not in capture schema" : undefined}
                    >
                      {fieldId}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Source */}
          {rule.source?.excerpt && (
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Source</p>
              <blockquote className="border-l-2 border-gray-600 pl-3 text-xs text-gray-400 italic">
                <p>{rule.source.excerpt}</p>
                <footer className="mt-1 text-gray-500 not-italic">
                  — {rule.source.document}
                  {rule.source.page != null ? `, p.${rule.source.page}` : ""}
                  {rule.source.section ? ` § ${rule.source.section}` : ""}
                </footer>
              </blockquote>
            </div>
          )}

          {/* Tests */}
          {rule.tests && rule.tests.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Tests ({rule.tests.length})</p>
              <div className="space-y-1.5">
                {rule.tests.map((test, i) => {
                  const result = rule.testResults?.[i];
                  const pass = result?.pass;
                  const hasMismatch = result && !pass;
                  return (
                    <div key={i} className={`rounded p-2 text-xs font-mono ${result ? (pass ? "bg-green-950/40 border border-green-900/50" : "bg-red-950/40 border border-red-900/50") : "bg-gray-800/60"}`}>
                      <span className="mr-1">{result ? (pass ? "✓" : "✗") : "·"}</span>
                      <span className="text-gray-500">in: </span>{JSON.stringify(test.inputs)}{" "}
                      <span className="text-gray-500">→ </span>
                      <span className={test.expected.action === "decline" ? "text-red-400" : test.expected.action === "refer" ? "text-yellow-400" : "text-green-400"}>
                        {test.expected.action}
                      </span>
                      {hasMismatch && (
                        <span className="text-orange-400 ml-2">(got: {result.actualAction})</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* AI Correction */}
          <div className="pt-1 border-t border-gray-800/60">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Correct with AI</p>
            <textarea
              value={correctionText}
              onChange={(e) => setCorrectionText(e.target.value)}
              rows={2}
              placeholder='Describe the correction, e.g. "The minimum face amount should be $50,000 not $25,000" or "Use applicant_age field instead of proposed_insured_dob"'
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-xs focus:outline-none focus:border-blue-500 resize-none placeholder-gray-600"
            />
            {correctionError && <p className="text-xs text-red-400 mt-1 font-mono">{correctionError}</p>}
            <button
              onClick={handleAiCorrection}
              disabled={isCorrecting || !correctionText.trim()}
              className="mt-1.5 px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-medium transition-colors flex items-center gap-1.5"
            >
              {isCorrecting && <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />}
              {isCorrecting ? "Re-drafting…" : "Apply correction"}
            </button>
          </div>

          {/* JSON Editor */}
          <div className="pt-1 border-t border-gray-800/60">
            <button
              onClick={() => {
                setShowJsonEditor((v) => !v);
                if (!showJsonEditor) {
                  setJsonWhen(JSON.stringify(rule.when, null, 2));
                  setJsonThen(JSON.stringify(rule.then, null, 2));
                  setJsonInputs(JSON.stringify(rule.inputs, null, 2));
                  setJsonError("");
                }
              }}
              className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1 transition-colors"
            >
              <span className={`transition-transform text-gray-600 text-[10px] ${showJsonEditor ? "rotate-90" : ""}`}>▶</span>
              Edit rule logic (JSON)
            </button>
            {showJsonEditor && (
              <div className="mt-2 space-y-2">
                <div>
                  <p className="text-xs text-gray-500 mb-1">Condition (when)</p>
                  <textarea
                    value={jsonWhen}
                    onChange={(e) => setJsonWhen(e.target.value)}
                    rows={6}
                    spellCheck={false}
                    className="w-full px-3 py-2 rounded bg-gray-950 border border-gray-700 text-green-300 text-xs font-mono focus:outline-none focus:border-blue-500 resize-y"
                  />
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">Outcome (then)</p>
                  <textarea
                    value={jsonThen}
                    onChange={(e) => setJsonThen(e.target.value)}
                    rows={3}
                    spellCheck={false}
                    className="w-full px-3 py-2 rounded bg-gray-950 border border-gray-700 text-green-300 text-xs font-mono focus:outline-none focus:border-blue-500 resize-y"
                  />
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">Inputs (field IDs)</p>
                  <textarea
                    value={jsonInputs}
                    onChange={(e) => setJsonInputs(e.target.value)}
                    rows={2}
                    spellCheck={false}
                    className="w-full px-3 py-2 rounded bg-gray-950 border border-gray-700 text-green-300 text-xs font-mono focus:outline-none focus:border-blue-500 resize-y"
                  />
                </div>
                {jsonError && <p className="text-xs text-red-400 font-mono">{jsonError}</p>}
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSaveJson}
                    disabled={isSaving}
                    className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
                  >
                    {isSaving ? "Saving…" : "Save JSON"}
                  </button>
                  <button
                    onClick={() => setShowJsonEditor(false)}
                    className="px-3 py-1 rounded text-xs text-gray-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RulesList({ session, onSessionUpdate, onDraftRules, isDrafting }: RulesListProps) {
  const rules = session.rules ?? [];
  const hasSchema = session.captureSchema.length > 0;
  const schemaFieldIds = new Set(
    session.captureSchema.flatMap((f) =>
      f.datatype === "array" && f.items ? [f.id, ...f.items.map((sub) => sub.id)] : [f.id]
    )
  );

  async function handleApproveHighConfidence() {
    const highConfidenceDrafts = rules.filter((r) => r.confidence === "high" && r.status === "draft");
    for (const rule of highConfidenceDrafts) {
      const res = await fetch(`/sessions/${session.id}/rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      const data = await res.json() as Session;
      onSessionUpdate(data);
    }
  }

  if (isDrafting) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24">
        <span className="inline-block w-10 h-10 border-4 border-gray-600 border-t-blue-400 rounded-full animate-spin" />
        <p className="text-gray-400 text-sm">Drafting rules with AI… this may take 30–60 seconds</p>
      </div>
    );
  }

  if (rules.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-xl font-bold text-white">Rules</h2>
        {hasSchema ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-6 flex flex-col items-start gap-4">
            <p className="text-gray-400 text-sm">
              No rules drafted yet. Click &ldquo;Draft Rules&rdquo; to generate rules from your
              capture schema and guidelines.
            </p>
            <button
              onClick={onDraftRules}
              disabled={isDrafting}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              Draft Rules
            </button>
          </div>
        ) : (
          <p className="text-gray-500 text-sm">Upload an application form first to build a capture schema.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Rules</h2>
        {hasSchema && (
          <button
            onClick={onDraftRules}
            disabled={isDrafting}
            className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-300 hover:text-white text-sm font-medium transition-colors"
          >
            Re-draft Rules
          </button>
        )}
      </div>

      <ReviewProgress
        rules={rules}
        onApproveHighConfidence={handleApproveHighConfidence}
        sessionId={session.id}
        onSessionUpdate={onSessionUpdate}
      />

      {(() => {
        // Group rules by jurisdiction: countrywide base first, then each state overlay.
        const groups = new Map<string, typeof rules>();
        for (const r of rules) {
          const j = r.jurisdiction || "US";
          if (!groups.has(j)) groups.set(j, []);
          groups.get(j)!.push(r);
        }
        const order = [...groups.keys()].sort((a, b) => (a === "US" ? -1 : b === "US" ? 1 : a.localeCompare(b)));
        const multi = order.length > 1;

        return order.map((j) => (
          <div key={j} className="space-y-3">
            {multi && (
              <div className="flex items-center gap-2 pt-2">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${j === "US" ? "bg-gray-700 text-gray-300" : "bg-orange-900 text-orange-300"}`}>
                  {j === "US" ? "Countrywide base" : `${j} overlay`}
                </span>
                <span className="text-xs text-gray-500">{groups.get(j)!.length} rule{groups.get(j)!.length !== 1 ? "s" : ""}</span>
                <div className="flex-1 h-px bg-gray-800" />
              </div>
            )}
            {groups.get(j)!.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                sessionId={session.id}
                onUpdate={onSessionUpdate}
                schemaFieldIds={schemaFieldIds}
              />
            ))}
          </div>
        ));
      })()}
    </div>
  );
}
