"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Redesign 2026-11 — underline tabs under the page title.
 *
 * The selected tab lives in `?sub=<id>` so links and reloads keep it. The
 * URL is updated with `history.replaceState` (Next.js syncs it with
 * `useSearchParams`), so switching tabs never refetches the page.
 */
export function useSubTab<T extends string>(
  values: readonly T[],
  fallback: T,
  opts: {
    /** Wins over `?sub=` on first render (e.g. a deep link that needs "all"). */
    initial?: T | null | undefined;
    /** Query keys dropped from the URL when the tab changes. */
    clear?: readonly string[];
  } = {}
): [T, (next: T) => void] {
  const searchParams = useSearchParams();
  const fromUrl = searchParams?.get("sub") ?? null;
  const valid = (v: string | null): v is T =>
    v !== null && (values as readonly string[]).includes(v);
  const [value, setValue] = useState<T>(opts.initial ?? (valid(fromUrl) ? fromUrl : fallback));

  // Back/forward or a link to another tab of the same page.
  const lastUrlValue = useRef(fromUrl);
  useEffect(() => {
    if (fromUrl === lastUrlValue.current) return;
    lastUrlValue.current = fromUrl;
    setValue(valid(fromUrl) ? fromUrl : fallback);
    // `values` is a constant list per page: not a dependency.
  }, [fromUrl, fallback]);

  const select = (next: T) => {
    setValue(next);
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (next === fallback) params.delete("sub");
    else params.set("sub", next);
    for (const k of opts.clear ?? []) params.delete(k);
    const qs = params.toString();
    lastUrlValue.current = next === fallback ? null : next;
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  };

  return [value, select];
}

export interface TabDef<T extends string> {
  id: T;
  label: string;
  /** Small count shown after the label. */
  count?: number | undefined;
}

/**
 * Tab row: accent text and a 2px accent underline on the selected tab, a
 * hairline under the row. Arrow keys, Home and End move between tabs.
 * Scrolls horizontally when the labels do not fit (mobile).
 */
export function UnderlineTabs<T extends string>({
  label,
  idBase,
  tabs,
  value,
  onChange,
}: {
  /** Accessible name of the tab list, e.g. "Skills sections". */
  label: string;
  /** Prefix for the tab and panel ids. */
  idBase: string;
  tabs: readonly TabDef<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const t = tabs[next]!;
    onChange(t.id);
    refs.current[t.id]?.focus();
  };

  return (
    <div className="-mx-4 px-4 md:mx-0 md:px-0 mb-8 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex gap-7 border-b border-border min-w-max md:min-w-0"
      >
        {tabs.map((t) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${idBase}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${idBase}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={`-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-1 pb-3 pt-1 text-sm font-medium transition-colors rounded-t-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                selected
                  ? "border-accent text-accent"
                  : "border-transparent text-text-dim hover:text-text hover:border-border"
              }`}
            >
              {t.label}
              {t.count !== undefined && (
                <span
                  className={`text-xs tabular-nums ${selected ? "text-accent" : "text-text-muted"}`}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The panel the selected tab controls. */
export function TabPanel({
  idBase,
  value,
  children,
}: {
  idBase: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${value}`}>
      {children}
    </div>
  );
}
