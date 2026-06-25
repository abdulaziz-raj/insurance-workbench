export interface SourceRef {
  document: string;
  page?: number;
  section?: string;
  excerpt: string;
}

export interface CaptureField {
  id: string;
  label: string;
  section: string;
  datatype: "string" | "number" | "date" | "boolean" | "enum" | "currency" | "array";
  required: boolean;
  options?: string[];
  validation?: { min?: number; max?: number; regex?: string };
  reflexiveTriggers?: { when: string; reveal: string[] }[];
  // Present when datatype === "array": the fields of each item in the repeating section
  items?: CaptureField[];
  source: SourceRef;
  // Where this field came from. Absent = AI-extracted (legacy). "manual" = reviewer-added,
  // "edited" = AI-extracted but reviewer changed its metadata. Used for the provenance/audit trail.
  provenance?: "extracted" | "manual" | "edited";
}

export type RuleType = "knockout" | "eligibility" | "disclosure" | "validation" | "rating_placeholder";
export type Confidence = "high" | "medium" | "low";

export interface Condition {
  field?: string;
  op?: string;
  value?: unknown;
  all?: Condition[];
  any?: Condition[];
  // Quantifiers for array fields: `each` = every item satisfies cond, `some` = at least one item satisfies cond
  each?: { field: string; cond: Condition };
  some?: { field: string; cond: Condition };
}

export interface Outcome {
  action: string;
  params?: Record<string, unknown>;
}

export interface RuleTest {
  inputs: Record<string, unknown>;
  expected: Outcome;
}

export interface TestRunResult {
  index: number;
  pass: boolean;
  actualAction: string;
  expectedAction: string;
  inputs: Record<string, unknown>;
}

export type ReviewStatus = "draft" | "approved" | "rejected" | "needs_review";

export interface Rule {
  id: string;
  type: RuleType;
  description: string;
  inputs: string[];
  when: Condition;
  then: Outcome;
  source: SourceRef;
  confidence: Confidence;
  status: ReviewStatus;
  tests: RuleTest[];
  testStatus: "pass" | "fail" | "untested";
  testResults?: TestRunResult[];
  generatedBy: string;
  approvedBy?: string;
  reviewedAt?: string;
  notes?: string;
  // Which ruleset this rule belongs to when published: "US" = countrywide base,
  // a state code (e.g. "CA") = that state's overlay. Set during drafting.
  jurisdiction?: string;
}

export interface CoverageReport {
  unusedFields: string[];
  rulesMissingInputs: string[];
  sectionsWithNoRules: string[];
}

export type DocumentRole =
  | "application_form"
  | "acord_form"
  | "guidelines"
  | "state_addendum"
  | "other";

export interface DocumentEntry {
  id: string;
  name: string;
  role: DocumentRole;
  uploadedAt: string;
  status: "extracting" | "ready" | "error";
  fields: CaptureField[];
  rawText?: string;
  pages?: { page: number; text: string }[];
  error?: string;
  // Detected jurisdiction ("US" or a state code). For a state_addendum this routes the
  // document into that state's overlay during drafting.
  jurisdiction?: string;
}

export type AuditAction =
  | "document_uploaded"
  | "document_role_changed"
  | "session_renamed"
  | "schema_extracted"
  | "schema_field_added"
  | "schema_field_edited"
  | "schema_field_deleted"
  | "rules_drafted"
  | "rule_status_changed"
  | "rule_edited"
  | "rule_logic_edited"
  | "rule_corrected"
  | "tests_run"
  | "tests_fixed"
  | "ruleset_published";

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: AuditAction;
  /** The thing acted on — a rule id, document name, ruleset version, etc. */
  target?: string;
  /** Human-readable summary of what changed. */
  summary: string;
  /** Optional structured before/after or extra context. */
  details?: Record<string, unknown>;
}

export interface Session {
  id: string;
  productName: string;
  // The jurisdiction this session authors: "US" (countrywide base) or a state (e.g. "CA").
  jurisdiction?: string;
  createdAt: string;
  status: "empty" | "extracting" | "ready" | "error";
  documents: DocumentEntry[];
  captureSchema: CaptureField[];
  rules?: Rule[];
  draftedAt?: string;
  error?: string;
  auditLog?: AuditEntry[];
  // IDs of AI-extracted fields the reviewer has deleted — kept so re-merging documents
  // (on upload or re-extract) does not resurrect them.
  deletedFieldIds?: string[];
  // (overlay sessions only) base rule ids this jurisdiction removes — produced by overlay
  // drafting, carried into publish as the RulesetVersion.disabledBaseRuleIds.
  disabledBaseRuleIds?: string[];
  // Combined model: per-state base rule ids removed by that state's overlay (keyed by state).
  overlayDisabled?: Record<string, string[]>;
}

export interface RulesetVersion {
  id: string;
  version: string;
  productName: string;
  // "US" = countrywide base; a state code/name (e.g. "CA") = a jurisdiction overlay.
  jurisdiction: string;
  // base = countrywide ruleset; overlay = state-specific deltas applied on top of the base.
  kind: "base" | "overlay";
  // (overlays only) base rule ids this jurisdiction removes.
  disabledBaseRuleIds?: string[];
  effectiveDate: string;
  status: "draft" | "published";
  captureSchema: CaptureField[];
  rules: Rule[];
  coverage: CoverageReport;
  createdAt: string;
  publishedAt?: string;
  sessionId: string;
}
