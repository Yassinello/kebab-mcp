/**
 * TRU-04 — /approve/<id>: the user reviews an outgoing action the assistant
 * prepared (tool, account, recipient, exact text) and approves or rejects
 * it, outside the conversation the model controls.
 *
 * Admin-gated twice: by `proxy.ts` (same sign-in flow and cookie as
 * /config) and here, server-side, with `checkAdminAuth`. The link carries
 * an HMAC (`sig`) over the preview id and tenant; a bad signature renders
 * nothing about the preview.
 *
 * A settings change proposed by `kebab_config` gets its own wording: it is
 * applied as soon as the owner approves it here (no second step).
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { PRODUCT } from "@/core/constants/brand";
import { checkAdminAuth } from "@/core/auth";
import { getPreview, verifyApprovalSignature, type ApprovalRecord } from "@/core/approvals";
import { runWithTenant } from "@/core/request-context";
import { CONFIG_TOOL } from "@/core/config-proposals";
import { ApprovalActions } from "./approval-actions";
import { KebabLogo } from "../../components/kebab-logo";
import { StatusDot } from "../../components/list-rows";
import { requesterLabel } from "./requester-label";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Approve an action — ${PRODUCT.name}`,
  robots: { index: false, follow: false },
};

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Redesign 2026-11: the dashboard's frame — warm background, a slim bar
 * with the Kebab House tile, and one white panel with a thin border
 * (full-bleed on phones). No sidebar: this page is one decision.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg-app text-text flex flex-col">
      <header className="flex items-center gap-2.5 h-14 px-4 md:px-6">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-text">
          <KebabLogo size={18} className="text-amber-400" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium leading-tight">{PRODUCT.name}</span>
          <span className="block text-xs text-text-muted leading-tight">Personal AI hub</span>
        </span>
        <a
          href="/config"
          className="ml-auto text-sm font-medium text-text-dim hover:text-text rounded-lg px-2.5 py-2 hover:bg-bg-nav-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Open dashboard
        </a>
      </header>
      <main className="flex-1 md:px-6 md:pb-10 md:pt-6">
        <div className="mx-auto w-full max-w-2xl bg-bg border-y md:border border-border md:rounded-2xl">
          {children}
        </div>
      </main>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <div className="px-6 py-8 md:px-10">
        <h1 className="text-[24px] md:text-[26px] font-normal leading-tight tracking-tight mb-2">
          {title}
        </h1>
        <p className="text-sm text-text-dim">{body}</p>
      </div>
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[9rem_1fr] gap-1 sm:gap-4 py-3.5 border-b border-border">
      <dt className="text-[13px] text-text-muted">{label}</dt>
      <dd className="text-sm break-words min-w-0">{children}</dd>
    </div>
  );
}

function PageHeader({ status, title, body }: { status: string; title: string; body: string }) {
  return (
    <header className="px-6 pt-8 pb-6 md:px-10">
      <StatusDot tone="warn" label={status} />
      <h1 className="mt-3 text-[24px] md:text-[28px] font-normal leading-tight tracking-tight">
        {title}
      </h1>
      <p className="text-sm md:text-[15px] text-text-dim mt-2">{body}</p>
    </header>
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
  const isConfig = rec.tool === CONFIG_TOOL;
  if (rec.status === "consumed") {
    if (isConfig) {
      return (
        <Notice
          title="Already applied"
          body="This change was already applied. You can go back to your conversation."
        />
      );
    }
    return (
      <Notice
        title="Already sent"
        body="This approved action was executed once; an approval cannot be reused. Ask the assistant for a new preview to send something else."
      />
    );
  }

  const { summary } = rec;
  const details = Object.entries(summary.details);

  if (isConfig) {
    return (
      <Shell>
        <PageHeader
          status="Confirmation needed"
          title="Your assistant proposes a settings change"
          body="Nothing has changed yet. If you approve, exactly this change is applied right away."
        />

        <dl className="mx-6 md:mx-10 border-t border-border">
          <Row label="Change">
            <span className="font-medium">{summary.recipient}</span>
          </Row>
          {rec.requestedBy ? (
            <Row label="Requested by">{requesterLabel(rec.requestedBy)}</Row>
          ) : null}
        </dl>

        <section className="px-6 md:px-10 pt-6">
          <h2 className="text-sm font-semibold mb-2">What changes</h2>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm rounded-lg border border-border bg-bg-muted p-4 max-h-80 overflow-auto">
            {summary.text ?? "—"}
          </pre>
        </section>

        <ApprovalActions
          id={rec.id}
          sig={sig!}
          tenant={tenant}
          // An approved but not yet applied change (an earlier attempt
          // failed midway) can be approved again: it applies once.
          status="pending"
          minutesLeft={minutesLeft(rec)}
          kind="config"
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <PageHeader
        status="Approval needed"
        title="Your assistant wants to act on your behalf"
        body="Check every field. If you approve, exactly this will be sent — once — even if the assistant asks for something else afterwards."
      />

      <dl className="mx-6 md:mx-10 border-t border-border">
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
        {rec.requestedBy ? <Row label="Requested by">{requesterLabel(rec.requestedBy)}</Row> : null}
      </dl>

      <section className="px-6 md:px-10 pt-6">
        <h2 className="text-sm font-semibold mb-2">Exact text</h2>
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
