import { v4 as uuidv4 } from "uuid";
import type { AuditAction, AuditEntry, Session } from "@workbench/schema";

/**
 * Append an audit entry to a session's log (in-place). The caller is
 * responsible for persisting the session afterwards via saveSession.
 *
 * Actor defaults to "reviewer" — there is no auth/user system yet, so this is
 * a placeholder. When auth lands, pass the authenticated user's identity.
 */
export function appendAudit(
  session: Session,
  action: AuditAction,
  summary: string,
  opts: { target?: string; details?: Record<string, unknown>; actor?: string } = {},
): AuditEntry {
  const entry: AuditEntry = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    actor: opts.actor ?? "reviewer",
    action,
    target: opts.target,
    summary,
    details: opts.details,
  };
  if (!session.auditLog) session.auditLog = [];
  session.auditLog.push(entry);
  return entry;
}
