"use client";

import { useState } from "react";

/** Mirrors AccessLevel in src/core/devices.ts (kept local: this is a client component). */
type Access = "read" | "memory" | "full";

/**
 * Audit 2026-11 — the three access levels offered on the consent page, in
 * plain words. Default: "memory" (read + save to your own profile, notes
 * and skills), so onboarding works without letting the client send anything.
 */
const ACCESS_CHOICES: { value: Access; title: string; detail: string }[] = [
  {
    value: "read",
    title: "Read only",
    detail: "Load skills, read your profile and notes.",
  },
  {
    value: "memory",
    title: "Read + my profile and notes (recommended)",
    detail: "Also save to your profile, notes and skills.",
  },
  {
    value: "full",
    title: "Everything",
    detail:
      "Also send messages and change things in your connected apps. Each message still needs your approval.",
  },
];

/**
 * Kebab House phase 1 (OAU-06, TRU-05) — consent form. The decision is
 * POSTed with fetch and the browser then navigates to the returned URL:
 * this keeps the CSP `form-action 'self'` intact (a form POST answered by
 * a cross-site 302 would be blocked).
 */
export function AuthorizeForm(props: {
  query: string;
  clientName: string;
  clientId: string;
  clientKind: string;
  /** Host for web callbacks; the whole URI for an app's own scheme. */
  redirectTarget: string;
  redirectIsApp: boolean;
  profiles: string[];
  /** Settings of this client's existing device (re-authorization), if any. */
  existing?: {
    label: string;
    profile: string | null;
    skillTags: string[] | null;
    access: Access;
  } | null;
}) {
  const existing = props.existing ?? null;
  const [label, setLabel] = useState((existing?.label ?? props.clientName).slice(0, 40));
  const [skillTags, setSkillTags] = useState((existing?.skillTags ?? []).join(", "));
  const [profile, setProfile] = useState(existing?.profile ?? "");
  const [access, setAccess] = useState<Access>(existing?.access ?? "memory");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/authorize", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: props.query,
          decision,
          label,
          skillTags: skillTags
            .split(/[,\s]+/)
            .map((t) => t.replace(/^#/, "").trim())
            .filter(Boolean),
          profile: profile || null,
          access,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { redirect?: string; message?: string };
      if (!res.ok || !data.redirect) {
        setError(data.message || "Something went wrong. Reload the page and try again.");
        setBusy(false);
        return;
      }
      window.location.assign(data.redirect);
    } catch {
      setError("Network error. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Connect {props.clientName}?</h1>
        <p className="text-sm text-text-dim mt-1">
          It will be able to use your Kebab House: your skills, your profile and what you allow
          below.
        </p>
        {props.redirectIsApp ? (
          <p className="text-sm text-text-dim mt-2">
            You will then be sent to this app on your computer:{" "}
            <span className="font-mono break-all">{props.redirectTarget}</span>. Only continue if
            you just started this connection from that app.
          </p>
        ) : (
          <p className="text-sm text-text-dim mt-2">
            You will then be sent back to <span className="font-mono">{props.redirectTarget}</span>.
          </p>
        )}
        {existing && (
          <p className="text-[11px] text-text-muted mt-1">
            This client is already in your Devices list as “{existing.label}”. Its settings are kept
            unless you change them here.
          </p>
        )}
        {props.clientKind === "cimd" && (
          <p className="text-[11px] text-text-muted mt-1 break-all">
            Client identity: <span className="font-mono">{props.clientId}</span>
          </p>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium mb-1">What can it do?</legend>
        {ACCESS_CHOICES.map((c) => (
          <label key={c.value} className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="radio"
              name="access"
              value={c.value}
              checked={access === c.value}
              onChange={() => setAccess(c.value)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">{c.title}</span>
              <span className="block text-text-dim">{c.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="block text-xs font-medium">
        Name in your Devices list
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={40}
          className="mt-1 w-full bg-bg-muted border border-border rounded-md px-3 py-1.5 text-sm"
        />
      </label>

      <label className="block text-xs font-medium">
        Profile this client uses
        <select
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          className="mt-1 w-full bg-bg-muted border border-border rounded-md px-3 py-1.5 text-sm"
        >
          <option value="">default</option>
          {props.profiles
            .filter((p) => p !== "default")
            .map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
        </select>
      </label>

      <label className="block text-xs font-medium">
        Skills this client sees (tags, empty = all)
        <input
          value={skillTags}
          onChange={(e) => setSkillTags(e.target.value)}
          placeholder="e.g. perso, rituals"
          className="mt-1 w-full bg-bg-muted border border-border rounded-md px-3 py-1.5 text-sm"
        />
      </label>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide("approve")}
          className="flex-1 bg-accent text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-accent/90 disabled:opacity-60"
        >
          {busy ? "Connecting…" : "Allow"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide("deny")}
          className="flex-1 border border-border text-sm font-medium px-4 py-2 rounded-md hover:bg-bg-muted disabled:opacity-60"
        >
          Deny
        </button>
      </div>
      <p className="text-[11px] text-text-muted">
        You can change all of this later in Settings → Devices.
      </p>
    </div>
  );
}
