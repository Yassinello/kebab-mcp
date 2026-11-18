"use client";

import { useState } from "react";

type Status = "pending" | "approved";
type UiState =
  | { kind: "idle" }
  | { kind: "sending"; decision: "approve" | "reject" }
  | { kind: "done"; status: "approved" | "applied" | "rejected" }
  | { kind: "error"; message: string };

const ERRORS: Record<string, string> = {
  not_found: "This approval no longer exists (expired or already rejected).",
  already_consumed: "This action was already executed.",
  bad_signature: "The approval link is invalid.",
};

/** Wording per kind of action: an outgoing message, or a settings change (kebab_config). */
const COPY = {
  send: {
    approve: "Approve and allow sending",
    rejected: "Rejected — nothing will be sent.",
  },
  config: {
    approve: "Approve and apply",
    rejected: "Rejected — nothing changed.",
  },
} as const;

export function ApprovalActions({
  id,
  sig,
  tenant,
  status,
  minutesLeft,
  kind = "send",
}: {
  id: string;
  sig: string;
  tenant: string | null;
  status: Status;
  minutesLeft: number;
  kind?: "send" | "config";
}) {
  const copy = COPY[kind];
  const [state, setState] = useState<UiState>(
    status === "approved" ? { kind: "done", status: "approved" } : { kind: "idle" }
  );

  async function send(decision: "approve" | "reject") {
    setState({ kind: "sending", decision });
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, sig, tenant }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        status?: string;
        message?: string;
      };
      if (res.ok && data.ok) {
        const done =
          decision === "reject" ? "rejected" : data.status === "applied" ? "applied" : "approved";
        setState({ kind: "done", status: done });
      } else if (data.error === "apply_failed") {
        setState({
          kind: "error",
          message: `Not applied: ${data.message ?? "the change is no longer valid."} Nothing changed.`,
        });
      } else {
        setState({
          kind: "error",
          message: ERRORS[data.error ?? ""] ?? `Request failed (${res.status}).`,
        });
      }
    } catch {
      setState({ kind: "error", message: "Network error — try again." });
    }
  }

  if (state.kind === "done") {
    const ok = state.status !== "rejected";
    return (
      <footer
        className={`px-6 py-5 border-t border-border mt-4 rounded-b-xl ${
          ok ? "bg-green-bg" : "bg-red-bg"
        }`}
      >
        <p className={`text-sm font-medium ${ok ? "text-green" : "text-red"}`}>
          {state.status === "applied"
            ? "Applied. You can go back to your conversation."
            : state.status === "approved"
              ? "Approved."
              : copy.rejected}
        </p>
        {state.status === "approved" ? (
          <p className="text-sm text-text-dim mt-1">
            Go back to your conversation and tell the assistant it is approved. It can send this
            exact action once, within {minutesLeft} min.
          </p>
        ) : null}
      </footer>
    );
  }

  const busy = state.kind === "sending";
  return (
    <footer className="px-6 py-5 border-t border-border mt-4 flex flex-col-reverse sm:flex-row sm:items-center gap-3">
      <p className="text-xs text-text-muted sm:mr-auto">
        Expires in {minutesLeft} min · single use
      </p>
      {state.kind === "error" ? <p className="text-xs text-red">{state.message}</p> : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => send("reject")}
        className="px-4 py-2 text-sm rounded-lg border border-border bg-bg hover:bg-bg-muted disabled:opacity-50"
      >
        {busy && state.decision === "reject" ? "Rejecting…" : "Reject"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => send("approve")}
        className="px-4 py-2 text-sm rounded-lg bg-green text-white font-medium hover:opacity-90 disabled:opacity-50"
      >
        {busy && state.decision === "approve" ? "Approving…" : copy.approve}
      </button>
    </footer>
  );
}
