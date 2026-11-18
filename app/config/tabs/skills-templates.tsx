"use client";

import { useEffect, useState } from "react";
import { StatusDot } from "../../components/list-rows";

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
  /** One benefit sentence for humans (falls back to description). */
  summary?: string;
  /** What to say to run it, e.g. "Morning brief". */
  example?: string;
  icon: string;
  tags: string[];
  status: "available" | "installed" | "modified";
}

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

  if (!templates) return <p className="text-sm text-text-muted">Loading templates…</p>;
  if (templates.length === 0) {
    return <p className="text-sm text-text-dim">No templates on this instance.</p>;
  }

  const installedCount = templates.filter((t) => t.status !== "available").length;

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
    <section aria-label="Templates">
      <div className="mb-4 max-w-2xl">
        <h2 className="text-base font-semibold text-text">Templates</h2>
        <p className="text-sm text-text-dim mt-1">
          Ready-made skills that use your profile and notes. Install one, then edit it like any
          skill. {installedCount} of {templates.length} installed.
        </p>
      </div>
      <ul className="border-t border-border">
        {templates.map((t) => {
          const installed = t.status === "installed";
          return (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-1 sm:px-2 py-4"
            >
              <span
                className="text-lg leading-none w-5 text-center shrink-0 self-start mt-0.5"
                aria-hidden="true"
              >
                {t.icon}
              </span>
              <div className="flex-1 min-w-[11rem]">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="text-[15px] font-medium text-text">{t.title}</p>
                  <code className="text-[12px] text-text-muted">{t.name}</code>
                  <StatusDot
                    tone={installed ? "ok" : t.status === "modified" ? "warn" : "off"}
                    label={
                      installed
                        ? "Installed"
                        : t.status === "modified"
                          ? "Changed"
                          : "Not installed"
                    }
                  />
                </div>
                <p className="text-[13px] text-text-dim mt-0.5" title={t.description}>
                  {t.summary ?? t.description}
                </p>
                {t.example ? (
                  <p className="text-[13px] text-text-muted mt-0.5">Say: “{t.example}”</p>
                ) : null}
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
                className={`ml-auto shrink-0 text-sm font-medium px-3 py-1.5 rounded-lg border whitespace-nowrap ${
                  installed
                    ? "border-border text-text-muted bg-bg-muted cursor-default"
                    : "border-border bg-bg text-accent hover:bg-accent/5 disabled:opacity-60"
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
            </li>
          );
        })}
      </ul>
      {error && <p className="text-xs text-red mt-3">{error}</p>}
    </section>
  );
}
