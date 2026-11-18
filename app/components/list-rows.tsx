import type { ReactNode } from "react";
import { OutlineIcon } from "./outline-icon";

/**
 * Redesign 2026-11 — list building blocks: a section (semibold heading and
 * a muted line), full-width rows split by hairlines, a status dot with its
 * label, and the chevron that opens a row in place.
 */

export type RowTone = "ok" | "warn" | "off";

const DOT: Record<RowTone, string> = {
  ok: "bg-green",
  warn: "bg-amber-primary",
  off: "bg-[#9ca3af]",
};

/** Coloured dot + plain label ("Active", "Needs setup", "Off"…). */
export function StatusDot({ tone, label }: { tone: RowTone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-text-dim whitespace-nowrap">
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${DOT[tone]}`} />
      {label}
    </span>
  );
}

export function ListSection({
  id,
  title,
  description,
  actions,
  children,
  className = "",
}: {
  /** Heading id, used to label the section. */
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons on the right of the heading. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={className}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 mb-4">
        <div className="min-w-0 max-w-2xl">
          <h2 id={id} className="text-base font-semibold text-text">
            {title}
          </h2>
          {description && <p className="text-sm text-text-dim mt-1">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** `<ul>` with a hairline on top; each row draws the hairline under it. */
export function RowList({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="border-t border-border" aria-label={label}>
      {children}
    </ul>
  );
}

/** Chevron button that opens or closes a row (rotates when open). */
export function RowChevron({
  open,
  onClick,
  label,
  controls,
}: {
  open: boolean;
  onClick: () => void;
  /** Row title, e.g. "Slack": the button reads "Show details for Slack". */
  label: string;
  controls: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`${open ? "Hide" : "Show"} details for ${label}`}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      <span className={`inline-flex transition-transform ${open ? "rotate-90" : ""}`}>
        <OutlineIcon name="chevron" size={16} />
      </span>
    </button>
  );
}

/** Small muted text on the right of a row ("7 tools", "2 clients"…). */
export function RowMeta({ children }: { children: ReactNode }) {
  return (
    <span className="text-[13px] text-text-dim whitespace-nowrap tabular-nums">{children}</span>
  );
}
