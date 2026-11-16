"use client";

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/core/relative-time";
import {
  LINKS,
  formatBytes,
  gettingStartedSteps,
  nextAction,
  parseHub,
  type HubData,
} from "./hub-state";

const DISMISS_KEY = "kebab.overview.gettingStartedDismissed";

/**
 * 2026-11 audit (C1.1) — top of the Overview: the admin-key warning,
 * the "Your Kebab House" card (profile, skills, clients, notes, one next
 * action) and the "Getting started" checklist.
 */
export function HubSection() {
  const [hub, setHub] = useState<HubData | null>(null);
  const [failed, setFailed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config/hub", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: unknown) => {
        if (!cancelled) setHub(parseHub(d));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      // localStorage unavailable — checklist stays visible
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // localStorage unavailable — hidden for this visit only
    }
  };

  if (failed) {
    return (
      <section className="border border-border rounded-lg p-5">
        <h2 className="text-base font-semibold">Your Kebab House</h2>
        <p className="text-sm text-text-dim mt-1">
          Could not load the state of your hub. Reload the page to try again.
        </p>
      </section>
    );
  }
  if (!hub) {
    return (
      <section className="border border-border rounded-lg p-5" aria-busy="true">
        <h2 className="text-base font-semibold">Your Kebab House</h2>
        <p className="text-sm text-text-muted mt-1">Loading…</p>
      </section>
    );
  }

  const steps = gettingStartedSteps(hub);
  const allDone = steps.every((s) => s.done);
  const action = nextAction(hub);

  return (
    <div className="space-y-6">
      {hub.adminKeyUsedAt && <AdminKeyWarning at={hub.adminKeyUsedAt} />}

      <section className="border border-border rounded-lg p-5" aria-labelledby="hub-title">
        <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-6 mb-4">
          <div className="flex-1">
            <h2 id="hub-title" className="text-base font-semibold">
              Your Kebab House
            </h2>
            <p className="text-sm text-text-dim mt-0.5">{action.why}</p>
          </div>
          <a
            href={action.href}
            className="self-start shrink-0 bg-accent text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-accent/90"
          >
            {action.label}
          </a>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <ProfileTile hub={hub} />
          <Tile
            title="Skills"
            href={LINKS.skills}
            value={hub.skills ? String(hub.skills.count) : "—"}
            detail={
              hub.skills
                ? `${hub.skills.rituals.installed} of ${hub.skills.rituals.total} rituals installed`
                : "Unavailable"
            }
          />
          <ClientsTile hub={hub} />
          <Tile
            title="Notes"
            href={LINKS.memory}
            value={hub.notes ? String(hub.notes.count) : "—"}
            detail={
              hub.notes
                ? hub.notes.count === 0
                  ? "Nothing saved yet"
                  : "in your memory"
                : "Memory unavailable"
            }
          />
        </div>
      </section>

      {!allDone && !dismissed && (
        <section className="border border-border rounded-lg p-5" aria-labelledby="gs-title">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 id="gs-title" className="text-base font-semibold">
              Getting started
            </h2>
            <button
              type="button"
              onClick={dismiss}
              className="text-xs text-text-dim hover:text-text underline"
            >
              Hide this list
            </button>
          </div>
          <ol className="space-y-2">
            {steps.map((s) => (
              <li key={s.id} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={`mt-0.5 w-5 h-5 shrink-0 rounded-full border flex items-center justify-center text-[11px] ${
                    s.done ? "bg-green-bg border-green text-green" : "border-border text-text-muted"
                  }`}
                >
                  {s.done ? "✓" : ""}
                </span>
                <div className="flex-1 min-w-0">
                  {s.done ? (
                    <p className="text-sm text-text-dim line-through">{s.label}</p>
                  ) : (
                    <a href={s.href} className="text-sm font-medium text-accent hover:underline">
                      {s.label}
                    </a>
                  )}
                  <p className="text-xs text-text-muted">
                    <span className="sr-only">{s.done ? "Done. " : "To do. "}</span>
                    {s.hint}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function AdminKeyWarning({ at }: { at: string }) {
  return (
    <div role="alert" className="border border-orange/40 bg-orange-bg rounded-lg p-4">
      <p className="text-sm font-semibold text-orange-dark">
        An AI client uses your admin key. Give it its own device token (Devices → Add device), so it
        cannot approve its own messages.
      </p>
      <p className="text-xs text-text-dim mt-1">
        Last seen {formatRelativeTime(at)}.{" "}
        <a href={LINKS.devices} className="text-accent font-medium hover:underline">
          Open Devices
        </a>
      </p>
    </div>
  );
}

function Tile({
  title,
  href,
  value,
  detail,
}: {
  title: string;
  href: string;
  value: string;
  detail: string;
}) {
  return (
    <a
      href={href}
      className="block border border-border rounded-lg p-4 hover:bg-bg-muted transition-colors"
    >
      <p className="text-xs font-medium text-text-dim">{title}</p>
      <p className="text-xl font-bold text-text mt-1">{value}</p>
      <p className="text-xs text-text-muted mt-0.5">{detail}</p>
    </a>
  );
}

function ProfileTile({ hub }: { hub: HubData }) {
  const p = hub.profile;
  let value = "—";
  let detail = "Unavailable";
  if (p) {
    if (p.mode === "vault") {
      value = "In your notes";
      detail = "Your profile is a note in your memory";
    } else if (!p.filled) {
      value = "Empty";
      detail = "Say “Set up my Kebab House” in your AI client";
    } else {
      value = "Filled";
      const when = p.updatedAt ? `updated ${formatRelativeTime(p.updatedAt)}` : "";
      const by = p.by ? ` by ${p.by}` : "";
      detail = [formatBytes(p.bytes), when ? `${when}${by}` : ""].filter(Boolean).join(" · ");
    }
  }
  return <Tile title="Profile" href={LINKS.profile} value={value} detail={detail} />;
}

function ClientsTile({ hub }: { hub: HubData }) {
  const c = hub.clients;
  if (!c) {
    return <Tile title="AI clients" href={LINKS.devices} value="—" detail="Unavailable" />;
  }
  const parts = [
    `${c.devices} device ${c.devices === 1 ? "key" : "keys"}`,
    `${c.oauth} signed-in ${c.oauth === 1 ? "app" : "apps"}`,
  ];
  const last = c.lastActivity ? `last active ${formatRelativeTime(c.lastActivity)}` : null;
  return (
    <Tile
      title="AI clients"
      href={LINKS.devices}
      value={`${c.connected} connected`}
      detail={[parts.join(", "), last].filter(Boolean).join(" · ")}
    />
  );
}
