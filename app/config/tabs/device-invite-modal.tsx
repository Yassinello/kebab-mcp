"use client";

/**
 * Phase 52 / DEV-01 — Add-device invite modal.
 * Flow: label → POST invite → copy URL + countdown. No QR (DEV-06 LOC).
 */

import { useEffect, useState } from "react";

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

export function DeviceInviteModal({ baseUrl, onClose }: { baseUrl: string; onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [invite, setInvite] = useState<{ url: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!invite) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [invite]);

  const onGenerate = async () => {
    setError(null);
    if (!label.trim()) return setError("Label is required");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "invite", label: label.trim() }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error || "Failed to generate invite");
      else setInvite({ url: body.url, expiresAt: body.expiresAt });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  const onCopy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(`${baseUrl}${invite.url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // silent-swallow-ok: user can select-copy from the visible URL panel.
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg bg-bg border border-border p-6 shadow-xl">
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-lg font-semibold">Add device</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text"
            aria-label="Close"
            type="button"
          >
            ×
          </button>
        </div>
        {!invite ? (
          <>
            <label className="block text-xs text-text-dim mb-1">Device label</label>
            <input
              type="text"
              placeholder="e.g. Claude Code on laptop"
              value={label}
              maxLength={40}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-bg-muted border border-border rounded focus:outline-none focus:border-accent"
            />
            {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={onGenerate}
                disabled={loading || !label.trim()}
                className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
              >
                {loading ? "Generating…" : "Generate invite URL"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs rounded border border-border text-text-dim hover:text-text"
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-text-dim mb-2">
              Share with the second device. Expires in{" "}
              <span className="text-text">{fmtCountdown(invite.expiresAt - now)}</span>.
            </p>
            <div className="bg-bg-muted border border-border rounded px-3 py-2 text-[11px] font-mono break-all">
              {baseUrl}
              {invite.url}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={onCopy}
                className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/90"
              >
                {copied ? "Copied!" : "Copy URL"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs rounded border border-border text-text-dim hover:text-text"
              >
                Done
              </button>
            </div>
            <p className="mt-3 text-[10px] text-text-muted">
              Single-use. Visiting mints a fresh token and appends it to this instance.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
