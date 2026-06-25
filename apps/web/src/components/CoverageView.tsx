import type { Session, Rule, CaptureField } from "@workbench/schema";

interface CoverageViewProps {
  session: Session;
}

// Flatten capture schema into (id, field) pairs, including array sub-fields.
function allFieldIds(schema: CaptureField[]): string[] {
  return schema.flatMap((f) =>
    f.datatype === "array" && f.items ? [f.id, ...f.items.map((s) => s.id)] : [f.id]
  );
}

function StatCard({ label, value, sub, tone = "default" }: {
  label: string; value: string | number; sub?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneColor = {
    default: "text-white",
    good: "text-green-400",
    warn: "text-yellow-400",
    bad: "text-red-400",
  }[tone];
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${toneColor}`}>{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function CoverageView({ session }: CoverageViewProps) {
  const schema = session.captureSchema;
  const allRules = session.rules ?? [];
  // Coverage counts all non-rejected rules (the working ruleset), not just approved.
  const rules = allRules.filter((r) => r.status !== "rejected");

  if (schema.length === 0) {
    return (
      <div>
        <h2 className="text-xl font-bold text-white mb-2">Schema Coverage</h2>
        <p className="text-gray-500 text-sm">Upload a document to build a capture schema first.</p>
      </div>
    );
  }

  const schemaFieldIdSet = new Set(allFieldIds(schema));

  // fieldId -> rules referencing it
  const fieldToRules = new Map<string, Rule[]>();
  for (const rule of rules) {
    for (const fid of rule.inputs) {
      const list = fieldToRules.get(fid) ?? [];
      list.push(rule);
      fieldToRules.set(fid, list);
    }
  }

  // Top-level field coverage (array sub-fields are covered via their parent id)
  const topFields = schema;
  const coveredFields = topFields.filter((f) => (fieldToRules.get(f.id)?.length ?? 0) > 0);
  const uncoveredFields = topFields.filter((f) => (fieldToRules.get(f.id)?.length ?? 0) === 0);

  // Section coverage
  const sections = [...new Set(schema.map((f) => f.section).filter(Boolean))];
  const sectionCovered = new Map<string, boolean>();
  for (const section of sections) {
    const fieldsInSection = schema.filter((f) => f.section === section);
    sectionCovered.set(section, fieldsInSection.some((f) => (fieldToRules.get(f.id)?.length ?? 0) > 0));
  }
  const uncoveredSections = sections.filter((s) => !sectionCovered.get(s));

  // Rule health
  const rulesMissingInputs = rules.filter((r) => r.inputs.length === 0);
  const rulesUnknownFields = rules
    .map((r) => ({ rule: r, unknown: r.inputs.filter((id) => !schemaFieldIdSet.has(id)) }))
    .filter((x) => x.unknown.length > 0);
  const rulesNoTests = rules.filter((r) => !r.tests || r.tests.length === 0);
  const rulesFailingTests = rules.filter((r) => r.testStatus === "fail");

  const byStatus = {
    approved: allRules.filter((r) => r.status === "approved").length,
    needs_review: allRules.filter((r) => r.status === "needs_review").length,
    draft: allRules.filter((r) => r.status === "draft").length,
    rejected: allRules.filter((r) => r.status === "rejected").length,
  };

  const fieldPct = topFields.length ? Math.round((coveredFields.length / topFields.length) * 100) : 0;
  const sectionPct = sections.length ? Math.round(((sections.length - uncoveredSections.length) / sections.length) * 100) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Schema Coverage</h2>
        <p className="text-gray-400 text-sm mt-1">
          How well the {rules.length} active rule{rules.length !== 1 ? "s" : ""} cover the {topFields.length}-field schema.
          Rejected rules are excluded.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Field coverage" value={`${fieldPct}%`} sub={`${coveredFields.length}/${topFields.length} fields`} tone={fieldPct >= 70 ? "good" : fieldPct >= 40 ? "warn" : "bad"} />
        <StatCard label="Section coverage" value={`${sectionPct}%`} sub={`${sections.length - uncoveredSections.length}/${sections.length} sections`} tone={sectionPct >= 70 ? "good" : sectionPct >= 40 ? "warn" : "bad"} />
        <StatCard label="Active rules" value={rules.length} sub={`${byStatus.approved} approved · ${byStatus.draft + byStatus.needs_review} pending`} />
        <StatCard label="Rule issues" value={rulesMissingInputs.length + rulesUnknownFields.length + rulesFailingTests.length} sub="missing inputs / unknown fields / failing" tone={(rulesMissingInputs.length + rulesUnknownFields.length + rulesFailingTests.length) === 0 ? "good" : "warn"} />
      </div>

      {/* Rule health issues */}
      {(rulesUnknownFields.length > 0 || rulesMissingInputs.length > 0 || rulesNoTests.length > 0 || rulesFailingTests.length > 0) && (
        <div className="rounded-lg border border-yellow-900/50 bg-yellow-950/10 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-yellow-400 uppercase tracking-wider">Rule Health</h3>
          {rulesUnknownFields.length > 0 && (
            <div>
              <p className="text-xs text-red-400 font-medium mb-1">{rulesUnknownFields.length} rule(s) reference unknown fields</p>
              <ul className="space-y-0.5">
                {rulesUnknownFields.map(({ rule, unknown }) => (
                  <li key={rule.id} className="text-xs text-gray-400 font-mono">
                    {rule.id} → <span className="text-red-400">{unknown.join(", ")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {rulesMissingInputs.length > 0 && (
            <div>
              <p className="text-xs text-yellow-300 font-medium mb-1">{rulesMissingInputs.length} rule(s) have no inputs</p>
              <p className="text-xs text-gray-500 font-mono">{rulesMissingInputs.map((r) => r.id).join(", ")}</p>
            </div>
          )}
          {rulesFailingTests.length > 0 && (
            <div>
              <p className="text-xs text-red-400 font-medium mb-1">{rulesFailingTests.length} rule(s) failing tests</p>
              <p className="text-xs text-gray-500 font-mono">{rulesFailingTests.map((r) => r.id).join(", ")}</p>
            </div>
          )}
          {rulesNoTests.length > 0 && (
            <div>
              <p className="text-xs text-gray-400 font-medium mb-1">{rulesNoTests.length} rule(s) have no tests</p>
              <p className="text-xs text-gray-500 font-mono">{rulesNoTests.map((r) => r.id).join(", ")}</p>
            </div>
          )}
        </div>
      )}

      {/* Uncovered fields */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">
          Uncovered fields <span className="text-gray-600 font-normal">({uncoveredFields.length})</span>
        </h3>
        {uncoveredFields.length === 0 ? (
          <p className="text-xs text-green-400">Every field is referenced by at least one rule. 🎉</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {uncoveredFields.map((f) => (
              <span key={f.id} className="text-xs font-mono px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700" title={`${f.label} · ${f.section}`}>
                {f.id}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Section coverage breakdown */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Coverage by section</h3>
        <div className="space-y-2">
          {sections.map((section) => {
            const fieldsInSection = schema.filter((f) => f.section === section);
            const coveredInSection = fieldsInSection.filter((f) => (fieldToRules.get(f.id)?.length ?? 0) > 0).length;
            const pct = Math.round((coveredInSection / fieldsInSection.length) * 100);
            return (
              <div key={section} className="flex items-center gap-3">
                <span className="text-xs text-gray-400 w-48 flex-shrink-0 truncate" title={section}>{section}</span>
                <div className="flex-1 h-2 rounded-full bg-gray-800 overflow-hidden">
                  <div className={`h-full ${pct >= 70 ? "bg-green-500" : pct >= 40 ? "bg-yellow-500" : pct > 0 ? "bg-orange-500" : "bg-gray-700"}`} style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs text-gray-500 w-16 text-right flex-shrink-0">{coveredInSection}/{fieldsInSection.length}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
