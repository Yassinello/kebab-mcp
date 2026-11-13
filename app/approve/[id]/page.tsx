/**
 * TRU-04 — /approve/<id>: the user reviews an outgoing action the assistant
 * prepared (tool, account, recipient, exact text) and approves or rejects
 * it, outside the conversation the model controls.
 *
 * Admin-gated twice: by `proxy.ts` (same sign-in flow and cookie as
 * /config) and here, server-side, with `checkAdminAuth`. The link carries
 * an HMAC (`sig`) over the preview id and tenant; a bad signature renders
 * nothing about the preview.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { PRODUCT } from "@/core/constants/brand";
import { checkAdminAuth } from "@/core/auth";
import { getPreview, verifyApprovalSignature, type ApprovalRecord } from "@/core/approvals";
import { runWithTenant } from "@/core/request-context";
import { ApprovalActions } from "./approval-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Approve an action — ${PRODUCT.name}`,
  robots: { index: false, follow: false },
};

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-bg-muted text-text flex items-start sm:items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-xl rounded-xl border border-border bg-bg-card shadow-sm">
        {children}
      </div>
    </main>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <div className="p-6">
        <h1 className="text-base font-semibold mb-1">{title}</h1>
        <p className="text-sm text-text-dim">{body}</p>
      </div>
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 py-2.5 border-b border-border-light last:border-b-0">
      <dt className="text-xs uppercase tracking-wide text-text-muted pt-0.5">{label}</dt>
      <dd className="text-sm break-words min-w-0">{children}</dd>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join("\n");
  return JSON.stringify(v);
}

function minutesLeft(rec: ApprovalRecord): number {
  return Math.max(0, Math.ceil((rec.expiresAt - Date.now()) / 60000));
}

export default async function ApprovePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const sig = one(query.sig);
  const tenant = one(query.t);

  // Defense in depth behind proxy.ts: never render a preview to a non-admin.
  const h = await headers();
  const authError = await checkAdminAuth(
    new Request(`http://${h.get("host") ?? "localhost"}/approve/${id}`, { headers: h })
  );
  if (authError) {
    return (
      <Notice
        title="Sign in required"
        body="Open this link in the browser where you are signed in to the dashboard."
      />
    );
  }

  if (!(await verifyApprovalSignature(id, tenant, sig))) {
    return (
      <Notice
        title="Invalid approval link"
        body="This link is incomplete or was altered. Ask the assistant for a new preview."
      />
    );
  }

  const rec = await (tenant ? runWithTenant(tenant, () => getPreview(id)) : getPreview(id));
  if (!rec) {
    return (
      <Notice
        title="This approval has expired"
        body="Approval links are valid for 15 minutes and disappear once rejected. Ask the assistant to prepare the action again."
      />
    );
  }
  if (rec.status === "consumed") {
    return (
      <Notice
        title="Already sent"
        body="This approved action was executed once; an approval cannot be reused. Ask the assistant for a new preview to send something else."
      />
    );
  }

  const { summary } = rec;
  const details = Object.entries(summary.details);

  return (
    <Shell>
      <header className="px-6 pt-6 pb-4 border-b border-border">
        <p className="text-xs font-medium text-amber-primary uppercase tracking-wide mb-1">
          Approval needed
        </p>
        <h1 className="text-lg font-semibold">Your assistant wants to act on your behalf</h1>
        <p className="text-sm text-text-dim mt-1">
          Check every field. If you approve, exactly this will be sent — once — even if the
          assistant asks for something else afterwards.
        </p>
      </header>

      <dl className="px-6 py-2">
        <Row label="Tool">
          <code className="font-mono text-[13px]">{rec.tool}</code>
        </Row>
        <Row label="From account">
          <code className="font-mono text-[13px]">{summary.account ?? "—"}</code>
        </Row>
        <Row label="To">
          <span className="font-medium">{summary.recipient}</span>
        </Row>
        {details.map(([k, v]) => (
          <Row key={k} label={k.replace(/_/g, " ")}>
            <span className="whitespace-pre-wrap">{formatValue(v)}</span>
          </Row>
        ))}
        {rec.requestedBy ? <Row label="Requested by">{rec.requestedBy}</Row> : null}
      </dl>

      <section className="px-6 pt-2 pb-2">
        <p className="text-xs uppercase tracking-wide text-text-muted mb-1.5">Exact text</p>
        {summary.text !== null ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm rounded-lg border border-border bg-bg-muted p-4 max-h-80 overflow-auto">
            {summary.text}
          </pre>
        ) : (
          <p className="text-sm text-text-dim italic">No text (see the fields above).</p>
        )}
      </section>

      <ApprovalActions
        id={rec.id}
        sig={sig!}
        tenant={tenant}
        status={rec.status}
        minutesLeft={minutesLeft(rec)}
      />
    </Shell>
  );
}
