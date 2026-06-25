import { useState } from "react";
import type { Session } from "@workbench/schema";
import UploadPanel from "./components/UploadPanel";
import SessionWorkspace from "./components/SessionWorkspace";
import RulesList from "./components/RulesList";
import SchemaViewer from "./components/SchemaViewer";
import CoverageView from "./components/CoverageView";
import AuditLogView from "./components/AuditLogView";

type Page = "dashboard" | "rules" | "schema" | "coverage" | "audit-log";

export default function App() {
  const [activePage, setActivePage] = useState<Page>("dashboard");
  const [session, setSession] = useState<Session | null>(null);
  const [isDrafting, setIsDrafting] = useState(false);

  async function handleDraftRules() {
    if (!session) return;
    setIsDrafting(true);
    try {
      const res = await fetch(`/sessions/${session.id}/draft-rules`, { method: "POST" });
      const text = await res.text();
      if (!text) throw new Error(`Server returned ${res.status} with empty body`);
      const data = JSON.parse(text) as Session;
      if (!res.ok) throw new Error((data as unknown as { error?: string }).error || `HTTP ${res.status}`);
      setSession(data);
    } catch (err) {
      console.error("Draft rules failed:", err);
    } finally {
      setIsDrafting(false);
    }
  }

  // Session is loaded explicitly via UploadPanel's dev quick-load or the upload flow.
  // No silent auto-load: the user should always choose which session to open.

  const navItems: { label: string; page: Page }[] = [
    { label: "Dashboard", page: "dashboard" },
    { label: "Rules", page: "rules" },
    { label: "Schema", page: "schema" },
    { label: "Coverage", page: "coverage" },
    { label: "Audit Log", page: "audit-log" },
  ];

  function renderDashboard() {
    if (!session) {
      return <UploadPanel onSessionReady={setSession} />;
    }
    return (
      <SessionWorkspace
        session={session}
        onSessionUpdate={setSession}
        onDraftRules={handleDraftRules}
        isDrafting={isDrafting}
      />
    );
  }

  function renderPage() {
    if (activePage === "dashboard") {
      return renderDashboard();
    }

    if (!session) {
      return <div className="text-gray-500 text-sm">Upload a document first.</div>;
    }

    if (activePage === "rules") {
      return (
        <RulesList
          session={session}
          onSessionUpdate={setSession}
          onDraftRules={handleDraftRules}
          isDrafting={isDrafting}
        />
      );
    }

    if (activePage === "schema") {
      return <SchemaViewer session={session} onSessionUpdate={setSession} />;
    }

    if (activePage === "coverage") {
      return <CoverageView session={session} />;
    }

    if (activePage === "audit-log") {
      return <AuditLogView session={session} />;
    }

    return null;
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex">
      {/* Sidebar */}
      <aside className="w-60 bg-gray-900 border-r border-gray-800 flex flex-col p-4 gap-2 flex-shrink-0">
        <span className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
          Workbench
        </span>
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => (
            <button
              key={item.page}
              onClick={() => setActivePage(item.page)}
              className={`text-left px-3 py-2 rounded text-sm transition-colors ${
                activePage === item.page
                  ? "bg-gray-800 text-white font-medium"
                  : "text-gray-300 hover:bg-gray-800 hover:text-white"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="mt-auto pt-4 border-t border-gray-800">
          <button
            onClick={() => { setSession(null); setActivePage("dashboard"); }}
            className="w-full px-3 py-2 rounded text-sm text-left text-gray-400 hover:bg-gray-800 hover:text-white transition-colors"
          >
            + New Ruleset
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-10 overflow-y-auto">
        {activePage === "dashboard" && !session && (
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">
              Rules Authoring Workbench
            </h1>
            <p className="text-gray-400 text-sm">
              Insurance product rules — capture, review, approve.
            </p>
          </div>
        )}

        {renderPage()}
      </main>
    </div>
  );
}
