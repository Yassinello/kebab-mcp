"use client";

import { useState } from "react";

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
  redirectHost: string;
  profiles: string[];
}) {
  const [label, setLabel] = useState(props.clientName.slice(0, 40));
  const [skillTags, setSkillTags] = useState("");
  const [profile, setProfile] = useState("");
  const [writeAllowed, setWriteAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/authorize", {
        method: "POST",
        credentials: "include",
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
          writeAllowed,
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
          It will be able to use your Kebab House: your skills, your profile and the tools you
          allow. You will be sent back to <span className="font-mono">{props.redirectHost}</span>.
        </p>
        {props.clientKind === "cimd" && (
          <p className="text-[11px] text-text-muted mt-1 break-all">
            Client identity: <span className="font-mono">{props.clientId}</span>
          </p>
        )}
      </div>

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
        Profile served by my_context
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
        Skill tags visible (empty = every skill)
        <input
          value={skillTags}
          onChange={(e) => setSkillTags(e.target.value)}
          placeholder="e.g. perso, rituals"
          className="mt-1 w-full bg-bg-muted border border-border rounded-md px-3 py-1.5 text-sm"
        />
      </label>

      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={writeAllowed}
          onChange={(e) => setWriteAllowed(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Allow actions that change things</span> (send messages,
          write notes, create issues…). Off by default: the client can read and load skills only.
          You can change this later in Devices.
        </span>
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
        Connector access can be narrowed later in Settings → Devices.
      </p>
    </div>
  );
}
