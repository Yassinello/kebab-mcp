"use client";

import { PRODUCT } from "@/core/constants/brand";
import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import pkg from "../package.json";
import { KebabLogo } from "./components/kebab-logo";
import { StorageModeBadge } from "./components/storage-mode-badge";
import { OutlineIcon } from "./components/outline-icon";
import { ConnectClaudeDialog } from "./components/connect-claude-dialog";

const VERSION = `v${pkg.version}`;

interface NavItem {
  href: string;
  tab: string;
  label: string;
  icon: string;
}

interface NavGroup {
  /** Small uppercase label above the group; none for the first group. */
  label: string | null;
  items: NavItem[];
}

// Redesign 2026-11: the main menu is grouped like the owner's other
// product — Overview alone, then the hub (what every AI client shares),
// the connections (services and clients) and the activity.
export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ href: "/config", tab: "overview", label: "Overview", icon: "grid" }],
  },
  {
    label: "Your hub",
    items: [
      { href: "/config?tab=profile", tab: "profile", label: "Profile", icon: "user" },
      { href: "/config?tab=skills", tab: "skills", label: "Skills", icon: "sparkles" },
      { href: "/config?tab=memory", tab: "memory", label: "Memory", icon: "notebook" },
    ],
  },
  {
    label: "Connections",
    items: [
      { href: "/config?tab=connectors", tab: "connectors", label: "Connectors", icon: "package" },
      { href: "/config?tab=devices", tab: "devices", label: "Devices", icon: "devices" },
    ],
  },
  {
    label: "Activity",
    items: [{ href: "/config?tab=logs", tab: "logs", label: "Logs", icon: "activity" }],
  },
];

export const PRIMARY_NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

// Power-user pages, kept but out of the way under "Advanced" (pinned at the
// bottom of the sidebar). Custom Tools is a sub-tab of Tools
// (?tab=tools&sub=custom); the legacy ?tab=custom-tools URL still resolves.
export const ADVANCED_NAV: NavItem[] = [
  { href: "/config?tab=tools", tab: "tools", label: "Tools", icon: "terminal" },
  { href: "/config?tab=playground", tab: "playground", label: "Playground", icon: "play" },
  { href: "/config?tab=health", tab: "health", label: "Health", icon: "heart" },
  { href: "/config?tab=storage", tab: "storage", label: "Storage", icon: "database" },
  { href: "/config?tab=documentation", tab: "documentation", label: "Documentation", icon: "book" },
  { href: "/config?tab=settings", tab: "settings", label: "Settings", icon: "settings" },
];

const ADVANCED_OPEN_KEY = "kebab.sidebar.advancedOpen";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function NavLink({
  item,
  active,
  disabled,
}: {
  item: NavItem;
  active: boolean;
  disabled: boolean;
}) {
  return (
    <li>
      <a
        href={disabled ? undefined : item.href}
        aria-current={active ? "page" : undefined}
        aria-disabled={disabled || undefined}
        // MOBILE-01: min-h-11 (~44px) keeps a thumb-sized hit area on
        // phones; md: returns to the compact desktop density.
        className={`relative flex items-center gap-3 rounded-lg px-3 py-2.5 md:py-[7px] min-h-11 md:min-h-0 text-[15px] transition-colors ${FOCUS_RING} ${
          active
            ? "bg-bg-nav-active text-text font-medium before:absolute before:-left-0.5 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-accent"
            : disabled
              ? "text-text-muted cursor-not-allowed opacity-60"
              : "text-text-dim hover:bg-bg-nav-hover hover:text-text"
        }`}
      >
        <span className={active ? "text-text" : "text-text-muted"}>
          <OutlineIcon name={item.icon} />
        </span>
        <span className="flex-1">{item.label}</span>
        {disabled && (
          <span className="text-[10px] bg-bg-nav-active text-text-muted px-1.5 py-0.5 rounded uppercase tracking-wide">
            Locked
          </span>
        )}
      </a>
    </li>
  );
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}

function useCurrentTab(): string {
  const searchParams = useSearchParams();
  const rawTab = searchParams?.get("tab") || "overview";
  // The legacy `?tab=custom-tools` URL resolves to the Tools tab's
  // "custom" sub-tab — highlight the Tools item for it.
  return rawTab === "custom-tools" ? "tools" : rawTab;
}

export function Sidebar({
  serverName = PRODUCT.name,
  setupMode = false,
  mobileOpen = false,
}: {
  serverName?: string | undefined;
  setupMode?: boolean | undefined;
  /** Phones: the menu button in the top bar shows or hides the sidebar. */
  mobileOpen?: boolean | undefined;
}) {
  const pathname = usePathname();
  const currentTab = useCurrentTab();
  const onConfig = pathname === "/config";
  const disabled = setupMode && pathname !== "/welcome";
  // C1.5: the Advanced group is collapsed by default, open when one of its
  // pages is the current one, and remembers the user's last choice.
  const inAdvanced = onConfig && ADVANCED_NAV.some((i) => i.tab === currentTab);
  const [advancedPref, setAdvancedPref] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(ADVANCED_OPEN_KEY);
      if (saved !== null) setAdvancedPref(saved === "1");
    } catch {
      // localStorage unavailable — keep the default
    }
  }, []);
  const advancedOpen = inAdvanced || advancedPref === true;
  const toggleAdvanced = () => {
    const next = !advancedOpen;
    setAdvancedPref(next);
    try {
      localStorage.setItem(ADVANCED_OPEN_KEY, next ? "1" : "0");
    } catch {
      // localStorage unavailable — the choice lasts for this page only
    }
  };

  return (
    <aside
      id="sidebar"
      className={`${mobileOpen ? "flex" : "hidden"} md:flex flex-col
        md:col-start-1 md:row-start-1 md:row-span-2
        md:sticky md:top-0 md:h-screen md:w-60
        bg-bg-app px-3 pb-3 pt-1 md:pt-4 border-b border-border md:border-b-0`}
    >
      {/* Workspace header: the instance, like a workspace switcher. It leads
          to the instance settings (name, time zone, language). */}
      <a
        href={disabled ? undefined : "/config?tab=settings"}
        title="Instance settings"
        className={`hidden md:flex items-center gap-2.5 rounded-lg px-2 py-2 mb-4 hover:bg-bg-nav-hover transition-colors ${FOCUS_RING}`}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-text">
          <KebabLogo size={20} className="text-amber-400" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-text truncate">{serverName}</span>
          <span className="block text-xs text-text-muted truncate">
            {setupMode ? "Setup mode" : "Personal AI hub"}
          </span>
        </span>
      </a>

      <nav className="flex-1 overflow-y-auto flex flex-col" aria-label="Dashboard">
        {NAV_GROUPS.map((group, gi) => {
          const labelId = group.label ? `nav-group-${gi}` : undefined;
          return (
            <div key={group.label ?? "home"} className={gi > 0 ? "mt-5" : ""}>
              {group.label && (
                <p
                  id={labelId}
                  className="px-3 mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted"
                >
                  {group.label}
                </p>
              )}
              <ul className="space-y-0.5" aria-labelledby={labelId}>
                {group.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={onConfig && currentTab === item.tab}
                    disabled={disabled}
                  />
                ))}
              </ul>
            </div>
          );
        })}

        {/* Pinned at the bottom: the power-user pages. */}
        <div className="mt-auto pt-4">
          <div className="border-t border-black/[0.06] pt-3">
            {advancedOpen && (
              <ul id="sidebar-advanced" className="space-y-0.5 mb-1">
                {ADVANCED_NAV.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={onConfig && currentTab === item.tab}
                    disabled={disabled}
                  />
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={toggleAdvanced}
              aria-expanded={advancedOpen}
              aria-controls="sidebar-advanced"
              className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 md:py-[7px] min-h-11 md:min-h-0 text-[15px] text-text-dim hover:bg-bg-nav-hover hover:text-text transition-colors ${FOCUS_RING}`}
            >
              <span className="text-text-muted">
                <OutlineIcon name="sliders" />
              </span>
              <span className="flex-1 text-left">Advanced</span>
              <span
                className={`text-text-muted inline-flex transition-transform ${advancedOpen ? "-rotate-90" : "rotate-90"}`}
              >
                <OutlineIcon name="chevron" size={14} />
              </span>
            </button>
          </div>
        </div>
      </nav>
    </aside>
  );
}

/**
 * Top-right account chip: initials, name and a chevron. Opens a small
 * panel with the version, the storage mode and a few links.
 */
function UserChip({ displayName }: { displayName: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const itemClass = `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-text-dim hover:bg-bg-muted hover:text-text ${FOCUS_RING}`;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className={`flex items-center gap-2 rounded-full md:rounded-lg pl-1 pr-1 md:pr-2 py-1 min-h-11 md:min-h-0 hover:bg-bg-nav-hover transition-colors ${FOCUS_RING}`}
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-green text-white text-[11px] font-semibold"
        >
          {getInitials(displayName)}
        </span>
        <span className="sr-only md:not-sr-only text-sm font-medium text-text max-w-40 truncate">
          {displayName}
        </span>
        <span className="sr-only">, account menu</span>
        <span
          aria-hidden="true"
          className={`hidden md:inline-flex text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          <OutlineIcon name="chevron-down" size={14} />
        </span>
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute right-0 top-full mt-2 w-64 rounded-xl border border-border bg-bg p-1.5 shadow-lg z-40"
        >
          <div className="px-2.5 pt-2 pb-2.5 border-b border-border mb-1.5">
            <p className="text-sm font-medium text-text truncate">{displayName}</p>
            <div className="mt-1 flex items-center gap-2 text-xs text-text-muted">
              <span>{VERSION}</span>
              <span aria-hidden="true">·</span>
              <span>Storage</span>
              <StorageModeBadge />
            </div>
          </div>
          <a href="/config?tab=settings" className={itemClass}>
            <OutlineIcon name="settings" size={16} />
            Settings
          </a>
          <a href="/config?tab=storage" className={itemClass}>
            <OutlineIcon name="database" size={16} />
            Storage
          </a>
          <a
            href="https://github.com/Yassinello/kebab-mcp"
            target="_blank"
            rel="noopener"
            className={itemClass}
          >
            <OutlineIcon name="github" size={16} />
            <span className="flex-1">GitHub repository</span>
            <OutlineIcon name="external" size={14} />
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Slim bar above the white panel: on phones the menu button and the
 * instance name on the left; everywhere the actions and the account chip
 * on the right.
 */
function TopBar({
  displayName,
  serverName,
  mobileOpen,
  onToggleMenu,
  onConnectClaude,
}: {
  displayName: string;
  serverName: string;
  mobileOpen: boolean;
  onToggleMenu: () => void;
  onConnectClaude: () => void;
}) {
  const actionClass = `inline-flex items-center gap-2 rounded-lg px-2.5 min-h-11 md:min-h-9 text-sm font-medium text-text-dim hover:bg-bg-nav-hover hover:text-text transition-colors ${FOCUS_RING}`;
  return (
    <header className="md:col-start-2 md:row-start-1 flex items-center gap-1 px-2 md:px-5 h-14 bg-bg-app">
      <button
        type="button"
        aria-label={mobileOpen ? "Close menu" : "Open menu"}
        aria-expanded={mobileOpen}
        aria-controls="sidebar"
        onClick={onToggleMenu}
        className={`md:hidden inline-flex min-w-11 min-h-11 items-center justify-center rounded-lg text-text-dim hover:bg-bg-nav-hover ${FOCUS_RING}`}
      >
        <OutlineIcon name={mobileOpen ? "x" : "menu"} size={22} />
      </button>
      <a
        href="/config"
        className={`md:hidden flex items-center gap-2 min-w-0 rounded-md ${FOCUS_RING}`}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-text">
          <KebabLogo size={16} className="text-amber-400" />
        </span>
        <span className="text-sm font-semibold text-text truncate">{serverName}</span>
      </a>
      <div className="ml-auto flex items-center gap-0.5 md:gap-1.5">
        <button type="button" onClick={onConnectClaude} className={actionClass}>
          <OutlineIcon name="plug" size={17} />
          <span className="sr-only sm:not-sr-only">Connect Claude</span>
        </button>
        <a
          href="/config?tab=documentation"
          aria-label="Documentation"
          title="Help and documentation"
          className={`${actionClass} min-w-11 md:min-w-9 justify-center px-0`}
        >
          <OutlineIcon name="help" size={18} />
        </a>
        <UserChip displayName={displayName} />
      </div>
    </header>
  );
}

export function AppShell({
  children,
  title,
  subtitle,
  displayName = "User",
  serverName = PRODUCT.name,
  setupMode,
  mcpUrl,
  narrow,
  wide,
}: {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
  displayName?: string;
  serverName?: string;
  setupMode?: boolean;
  /** The instance's MCP endpoint, for the "Connect Claude" dialog. */
  mcpUrl?: string;
  narrow?: boolean;
  /** Wide content area (e.g. Documentation) — fits TOC + reading column. */
  wide?: boolean;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  // Width tier: narrow < default < wide. Only one applies.
  const widthClass = wide ? "max-w-7xl" : narrow ? "max-w-3xl" : "max-w-6xl";
  const endpoint =
    mcpUrl ?? (typeof window !== "undefined" ? `${window.location.origin}/api/mcp` : "/api/mcp");
  return (
    // Phones: top bar, (menu), panel stacked. md+: sidebar column on the
    // warm background, top bar and the white panel on the right.
    <div className="min-h-screen bg-bg-app flex flex-col md:grid md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-[3.5rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-bg focus:px-3 focus:py-2 focus:text-sm focus:text-accent focus:shadow"
      >
        Skip to content
      </a>
      <TopBar
        displayName={displayName}
        serverName={serverName}
        mobileOpen={mobileOpen}
        onToggleMenu={() => setMobileOpen((v) => !v)}
        onConnectClaude={() => setConnectOpen(true)}
      />
      <Sidebar serverName={serverName} setupMode={setupMode} mobileOpen={mobileOpen} />
      <main
        id="main"
        className="md:col-start-2 md:row-start-2 flex-1 min-w-0 bg-bg border-t border-border md:border md:rounded-2xl md:mr-4 md:mb-4"
      >
        <div className={`${widthClass} px-4 py-6 md:px-12 md:py-10`}>
          <div className="mb-6 md:mb-8">
            <h1 className="text-[26px] md:text-[28px] font-normal leading-tight tracking-tight text-text">
              {title}
            </h1>
            {subtitle && <p className="text-sm md:text-[15px] text-text-dim mt-1.5">{subtitle}</p>}
          </div>
          {children}
        </div>
      </main>
      <ConnectClaudeDialog
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        mcpUrl={endpoint}
      />
    </div>
  );
}
