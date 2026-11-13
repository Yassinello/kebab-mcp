"use client";

import { useEffect, useState } from "react";

interface Item {
  name: string;
  count: number;
}
interface WeekUsage {
  week: string;
  total: number;
  notes: number;
  tools: Item[];
  skills: Item[];
  clients: Item[];
}

function delta(now: number, before: number | undefined): string {
  if (before === undefined) return "";
  const d = now - before;
  if (d === 0) return "same as last week";
  return `${d > 0 ? "+" : ""}${d} vs last week`;
}

/**
 * Kebab House phase 0 (USE-04) — "This week" card: calls, most loaded
 * skills, active clients, notes added, compared with last week.
 */
export function UsageCard() {
  const [weeks, setWeeks] = useState<WeekUsage[] | null>(null);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // fire-and-forget OK: card stays in its loading state on failure
    void fetch("/api/config/usage?weeks=2", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { enabled: boolean; weeks: WeekUsage[] } | null) => {
        if (cancelled || !d) return;
        setEnabled(d.enabled);
        setWeeks(d.weeks);
      })
      .catch(() => {
        // fire-and-forget OK: the card simply stays in its loading state
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [cur, prev] = weeks ?? [];

  return (
    <section>
      <h2 className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.1em] mb-3">
        This week {cur ? <span className="normal-case tracking-normal">· {cur.week}</span> : null}
      </h2>
      <div className="border border-border rounded-lg p-4">
        {!enabled ? (
          <p className="text-xs text-text-muted">
            Usage counters are off (<code className="font-mono">KEBAB_USAGE_COUNTERS=off</code>).
          </p>
        ) : !cur ? (
          <p className="text-xs text-text-muted">Loading…</p>
        ) : cur.total === 0 ? (
          <p className="text-xs text-text-muted">
            No tool call yet this week. Ask one of your AI clients to load a skill or read your
            profile to see it here.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div>
              <p className="text-2xl font-bold font-mono text-accent">{cur.total}</p>
              <p className="text-text-muted">tool calls · {delta(cur.total, prev?.total)}</p>
              <p className="mt-2 font-mono text-text">{cur.notes}</p>
              <p className="text-text-muted">notes added · {delta(cur.notes, prev?.notes)}</p>
            </div>
            <div>
              <p className="text-text-muted uppercase tracking-wide text-[10px] mb-1">Top skills</p>
              {cur.skills.length === 0 ? (
                <p className="text-text-muted">No skill loaded yet.</p>
              ) : (
                <ul className="space-y-0.5">
                  {cur.skills.slice(0, 5).map((s) => (
                    <li key={s.name} className="flex justify-between gap-2">
                      <span className="font-mono truncate">{s.name}</span>
                      <span className="text-text-muted">{s.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="text-text-muted uppercase tracking-wide text-[10px] mb-1">Clients</p>
              <ul className="space-y-0.5">
                {cur.clients.slice(0, 5).map((c) => (
                  <li key={c.name} className="flex justify-between gap-2">
                    <span className="truncate">{c.name}</span>
                    <span className="text-text-muted">{c.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
