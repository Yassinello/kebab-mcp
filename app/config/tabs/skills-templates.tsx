"use client";

import { useEffect, useState } from "react";

/**
 * Kebab House RIT-02 — ritual templates in the Skills tab. Install goes
 * through POST /api/config/skills/templates (regular import path:
 * versioning, update instead of duplicate).
 */

interface TemplateEntry {
  id: string;
  name: string;
  title: string;
  description: string;
  icon: string;
  tags: string[];
  status: "available" | "installed" | "modified";
}

const OPEN_KEY = "kebab.skills.templatesOpen";

export function SkillTemplatesSection({
  refreshKey,
  onInstalled,
}: {
  /** Changes whenever the skill list changes, to refresh install status. */
  refreshKey: string;
  onInstalled: (message: string) => void | Promise<void>;
}) {
  const [templates, setTemplates] = useState<TemplateEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config/skills/templates", { credentials: "include" })
      .then((r) => r.json())
      .then((d: { ok?: boolean; templates?: TemplateEntry[] }) => {
        if (!cancelled && d.ok && Array.isArray(d.templates)) setTemplates(d.templates);
      })
      .catch(() => {
        /* section stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(OPEN_KEY);
      if (saved !== null) setOpen(saved === "1");
    } catch {
      /* localStorage unavailable — keep default */
    }
  }, []);

  if (!templates || templates.length === 0) return null;

  const installedCount = templates.filter((t) => t.status !== "available").length;
  // Default: open until every template is installed.
  const isOpen = open ?? installedCount < templates.length;

  const toggle = () => {
    const next = !isOpen;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const install = async (t: TemplateEntry) => {
    if (
      t.status === "modified" &&
      !confirm(
        `Your "${t.name}" skill differs from the template. Replace its instructions with the template? The current text stays in its version history.`
      )
    ) {
      return;
    }
    setBusy(t.id);
    setError(null);
    try {
      const res = await fetch("/api/config/skills/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id: t.id }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; action?: string };
      if (data.ok) {
        await onInstalled(
          data.action === "updated" ? `Updated: ${t.name}` : `Installed: ${t.name}`
        );
      } else {
        setError(data.error || "Install failed");
      }
    } catch {
      setError("Network error");
    }
    setBusy(null);
  };

  return (
    <section className="border border-border rounded-lg overflow-hidden" aria-label="Templates">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-bg-muted/40 transition-colors"
        aria-expanded={isOpen}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text">
            Templates{" "}
            <span className="text-xs font-normal text-text-muted">
              · rituals · {installedCount}/{templates.length} installed
            </span>
          </p>
          <p className="text-xs text-text-dim mt-0.5">
            Ready-made skills that use your profile and notes. Install one, then edit it like any
            skill.
          </p>
        </div>
        <span className="text-xs text-text-muted">{isOpen ? "Hide" : "Show"}</span>
      </button>
      {isOpen && (
        <div className="border-t border-border p-3 grid gap-2 sm:grid-cols-2">
          {templates.map((t) => {
            const installed = t.status === "installed";
            return (
              <div
                key={t.id}
                className="flex items-start gap-3 border border-border rounded-md px-3 py-2.5 bg-bg"
              >
                <span className="text-lg leading-none mt-0.5" aria-hidden="true">
                  {t.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text">
                    {t.title} <code className="text-[11px] text-text-muted">{t.name}</code>
                  </p>
                  <p className="text-xs text-text-dim mt-0.5 line-clamp-2" title={t.description}>
                    {t.description}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => !installed && install(t)}
                  disabled={installed || busy === t.id}
                  aria-label={`${installed ? "Installed" : t.status === "modified" ? "Update" : "Install"} ${t.name}`}
                  title={
                    t.status === "modified"
                      ? "Your copy differs from the template: update it (saved as a new version)"
                      : undefined
                  }
                  className={`shrink-0 text-xs font-medium px-3 py-1.5 rounded-md border whitespace-nowrap ${
                    installed
                      ? "border-border text-green bg-green-bg cursor-default"
                      : "border-accent/30 text-accent hover:bg-accent/10 disabled:opacity-60"
                  }`}
                >
                  {installed
                    ? "Installed"
                    : busy === t.id
                      ? "Installing…"
                      : t.status === "modified"
                        ? "Update"
                        : "Install"}
                </button>
              </div>
            );
          })}
          {error && <p className="text-xs text-red sm:col-span-2">{error}</p>}
        </div>
      )}
    </section>
  );
}
