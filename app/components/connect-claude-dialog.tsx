"use client";

import { useEffect, useRef } from "react";
import { ConnectClaudeCard } from "./connect-claude-card";
import { OutlineIcon } from "./outline-icon";

/** Same target as the Overview card's "Kebab House skill" link. */
const KEBAB_SKILL_HREF = "/config?tab=skills&panel=kebab-skill";

/**
 * Redesign 2026-11 — the top bar's "Connect Claude" opens the Overview's
 * connect card in a dialog, from any page. Esc, the close button or a
 * click outside closes it; focus stays inside while it is open and goes
 * back to the button that opened it.
 */
export function ConnectClaudeDialog({
  open,
  onClose,
  mcpUrl,
}: {
  open: boolean;
  onClose: () => void;
  mcpUrl: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // The parent passes a new function each render: read it through a ref so
  // the effect below runs once per opening.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/40 px-3 py-6 sm:px-6 sm:py-12"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-claude-dialog-title"
        className="relative mx-auto w-full max-w-3xl rounded-2xl bg-bg p-1.5 shadow-xl"
      >
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-muted hover:bg-bg-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          <OutlineIcon name="x" size={18} />
        </button>
        <ConnectClaudeCard
          mcpUrl={mcpUrl}
          tone="light"
          skillHref={KEBAB_SKILL_HREF}
          id="connect-claude-dialog"
        />
      </div>
    </div>
  );
}
