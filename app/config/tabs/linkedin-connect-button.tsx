"use client";

/**
 * LinkedIn connect helper for the Browser Automation pack.
 *
 * Why this exists:
 *   The `linkedin_feed` tool replays a LinkedIn session from a persistent
 *   Browserbase context (env: BROWSERBASE_CONTEXT_LINKEDIN). If that context
 *   is empty (first-time setup) or its cookies have expired, the feed
 *   silently returns 0 posts. There is no surface in the Browserbase web
 *   dashboard to manage contexts — they are API-only objects.
 *
 *   This component wires up the only safe path: pop a Browserbase Live View
 *   for the user, let them sign in to LinkedIn manually (incl. MFA), then
 *   close the session. Cookies persist into the context. No password ever
 *   transits through Claude or OpenRouter.
 */

import { useState } from "react";

interface OpenResponse {
  ok: boolean;
  contextId?: string;
  contextCreated?: boolean;
  persistWarning?: string | null;
  sessionId?: string;
  liveViewUrl?: string;
  expiresAt?: string;
  error?: string;
}

export function LinkedinConnectButton({
  currentContextId,
  onSaved,
}: {
  currentContextId: string;
  onSaved: (id: string) => void;
}) {
  const [busy, setBusy] = useState<"opening" | "closing" | null>(null);
  const [session, setSession] = useState<{ id: string; contextId: string; url: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const masked = currentContextId.includes("•");
  const hasContext = currentContextId.length > 0 && !masked ? true : masked;

  async function openSession() {
    setBusy("opening");
    setError(null);
    setWarning(null);
    setInfo(null);
    try {
      const res = await fetch("/api/admin/browserbase/linkedin-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "open" }),
      });
      const data = (await res.json()) as OpenResponse;
      if (!data.ok || !data.liveViewUrl || !data.sessionId || !data.contextId) {
        setError(data.error || "Failed to open Browserbase session");
        return;
      }
      setSession({ id: data.sessionId, contextId: data.contextId, url: data.liveViewUrl });
      if (data.contextCreated) onSaved(data.contextId);
      if (data.persistWarning) setWarning(data.persistWarning);
      window.open(data.liveViewUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function closeSession() {
    if (!session) return;
    setBusy("closing");
    setError(null);
    try {
      const res = await fetch("/api/admin/browserbase/linkedin-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "close", sessionId: session.id }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setError(data.error || "Failed to close session");
        return;
      }
      setInfo("Session closed. LinkedIn cookies are saved to the persistent context.");
      setSession(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-t border-border pt-4 space-y-3">
      <div>
        <p className="text-sm font-semibold">LinkedIn session</p>
        <p className="text-xs text-text-dim mt-0.5">
          {hasContext
            ? "A Browserbase context is configured. Re-connect if linkedin_feed returns 0 posts (cookies expired)."
            : "Required for the linkedin_feed tool. Opens a Browserbase Live View where you log in to LinkedIn yourself — your password never leaves your browser."}
        </p>
      </div>

      {!session ? (
        <button
          onClick={openSession}
          disabled={busy === "opening"}
          className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim hover:text-text disabled:opacity-60"
        >
          {busy === "opening"
            ? "Opening Browserbase session..."
            : hasContext
              ? "Re-connect LinkedIn"
              : "Connect LinkedIn"}
        </button>
      ) : (
        <div className="space-y-2 bg-bg-muted/40 border border-border rounded-md p-3">
          <p className="text-xs text-text-dim leading-relaxed">
            A Browserbase Live View was opened in a new tab. In that window:
          </p>
          <ol className="text-xs text-text-dim list-decimal pl-5 space-y-1">
            <li>
              Navigate to <code className="font-mono">https://www.linkedin.com/login</code>
            </li>
            <li>Sign in (MFA / captcha will work — it&apos;s a real browser)</li>
            <li>
              Wait until your feed loads, then come back here and click &quot;I&apos;m done&quot;
            </li>
          </ol>
          <div className="flex items-center gap-3 flex-wrap pt-1">
            <a
              href={session.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-accent underline underline-offset-2"
            >
              Re-open Live View →
            </a>
            <button
              onClick={closeSession}
              disabled={busy === "closing"}
              className="text-sm font-medium px-3 py-1 rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-60"
            >
              {busy === "closing" ? "Closing..." : "I'm done — close session"}
            </button>
          </div>
          <p className="text-[11px] text-text-muted">
            Context ID: <code className="font-mono">{session.contextId}</code>
          </p>
        </div>
      )}

      {warning && (
        <div className="bg-orange-bg border border-orange/30 rounded-md p-3 text-xs text-orange">
          {warning}
        </div>
      )}
      {error && (
        <div className="bg-red-bg border border-red/20 rounded-md p-3 text-xs text-red break-words">
          {error}
        </div>
      )}
      {info && (
        <div className="bg-green-bg border border-green/20 rounded-md p-3 text-xs text-green">
          {info}
        </div>
      )}
    </div>
  );
}
