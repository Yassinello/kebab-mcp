"use client";

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import pkg from "../package.json";
import { KebabLogo } from "./components/kebab-logo";
import { StorageModeBadge } from "./components/storage-mode-badge";

const VERSION = `v${pkg.version}`;

const PRIMARY_NAV = [
  { href: "/config", tab: "overview", label: "Overview", icon: "grid" },
  { href: "/config?tab=connectors", tab: "connectors", label: "Connectors", icon: "package" },
  { href: "/config?tab=tools", tab: "tools", label: "Tools", icon: "terminal" },
  { href: "/config?tab=skills", tab: "skills", label: "Skills", icon: "sparkles" },
  { href: "/config?tab=playground", tab: "playground", label: "Playground", icon: "play" },
  { href: "/config?tab=logs", tab: "logs", label: "Logs", icon: "activity" },
];

const SECONDARY_NAV = [
  { href: "/config?tab=documentation", tab: "documentation", label: "Documentation", icon: "book" },
  { href: "/config?tab=storage", tab: "storage", label: "Storage", icon: "database" },
  { href: "/config?tab=health", tab: "health", label: "Health", icon: "heart" },
  { href: "/config?tab=devices", tab: "devices", label: "Devices", icon: "devices" },
  { href: "/config?tab=settings", tab: "settings", label: "Settings", icon: "settings" },
];

const ICONS: Record<string, string> = {
  grid: "M4 5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5Zm10 0a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V5ZM4 15a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4Zm10 0a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4Z",
  package:
    "m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12",
  terminal: "m4 17 6-6-6-6m8 14h8",
  sparkles:
    "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8",
  play: "M5 3l14 9-14 9V3z",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
  database:
    "M12 3c4.97 0 9 1.34 9 3v12c0 1.66-4.03 3-9 3s-9-1.34-9-3V6c0-1.66 4.03-3 9-3z M3 6c0 1.66 4.03 3 9 3s9-1.34 9-3 M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3",
  heart:
    "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z",
  settings:
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  devices:
    "M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z M8 22h8 M12 18v4",
};

function Icon({ name }: { name: string }) {
  const d = ICONS[name];
  if (!d) return null;
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

function renderNavItem(
  item: { href: string; tab: string; label: string; icon: string },
  pathname: string | null,
  currentTab: string,
  setupMode: boolean
) {
  const active = pathname === "/config" && currentTab === item.tab;
  const disabled = setupMode && pathname !== "/welcome";
  return (
    <li key={item.href}>
      <a
        href={disabled ? undefined : item.href}
        // MOBILE-01: min-h-11 (~44px) ensures thumb-tappable hit area on
        // mobile per Apple HIG / Material guidance. sm: shrinks back to
        // the previous compact density on desktop.
        className={`flex items-center gap-2.5 px-2.5 py-2.5 sm:py-1.5 min-h-11 sm:min-h-0 rounded-md text-sm transition-colors ${
          active
            ? "bg-accent/10 text-accent font-medium"
            : disabled
              ? "text-text-muted cursor-not-allowed opacity-50"
              : "text-text-dim hover:bg-bg-muted hover:text-text"
        }`}
      >
        <Icon name={item.icon} />
        <span className="flex-1">{item.label}</span>
        {disabled && (
          <span className="text-[9px] bg-bg-muted text-text-muted px-1.5 py-0.5 rounded uppercase tracking-wide">
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

export function Sidebar({
  displayName = "User",
  serverName = "Kebab MCP",
  setupMode = false,
}: {
  displayName?: string | undefined;
  serverName?: string | undefined;
  setupMode?: boolean | undefined;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams.get("tab") || "overview";
  const orgInitials = getInitials(serverName);
  const userInitials = getInitials(displayName);
  // MOBILE-01: open/close state for the mobile drawer. Closed by default
  // so the page content renders immediately on small screens.
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* MOBILE-01: top bar with hamburger — visible on < sm. */}
      <div className="sm:hidden flex items-center justify-between px-4 py-3 border-b border-border bg-bg-sidebar">
        <div className="flex items-center gap-2 min-w-0">
          <KebabLogo size={22} className="text-amber-400 shrink-0" />
          <p className="text-sm font-bold truncate">{serverName}</p>
        </div>
        <button
          type="button"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-bg-muted text-text-dim"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {mobileOpen ? <path d="M6 6l12 12M6 18L18 6" /> : <path d="M3 6h18M3 12h18M3 18h18" />}
          </svg>
        </button>
      </div>
      <aside
        className={`
        ${mobileOpen ? "flex" : "hidden"} sm:flex
        w-full sm:w-60 sm:h-screen sm:sticky sm:top-0 sm:shrink-0
        border-b sm:border-b-0 sm:border-r border-border
        bg-bg-sidebar flex-col
      `}
      >
        {/* Brand / Org header */}
        <div className="px-4 pt-6 pb-5">
          <div className="flex items-center gap-2 px-1 mb-3">
            <KebabLogo size={22} className="text-amber-400 shrink-0" />
            <p className="text-base font-bold tracking-tight">Kebab MCP</p>
          </div>
          <div className="flex items-center gap-2.5 bg-bg border border-border rounded-lg px-2.5 py-2">
            <div className="w-8 h-8 rounded-md bg-accent text-white flex items-center justify-center text-xs font-bold shrink-0">
              {orgInitials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate">{serverName}</p>
              <p className="text-[10px] text-text-muted truncate">
                {setupMode ? "Setup mode" : "Personal MCP Server"}
              </p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-4 overflow-y-auto flex flex-col">
          <ul className="space-y-0.5">
            {PRIMARY_NAV.map((item) => renderNavItem(item, pathname, currentTab, setupMode))}
          </ul>
          <div className="mt-auto pt-4">
            <ul className="space-y-0.5 border-t border-border pt-3">
              {SECONDARY_NAV.map((item) => renderNavItem(item, pathname, currentTab, setupMode))}
            </ul>
          </div>
        </nav>

        {/* Footer: user profile */}
        <div className="mt-auto border-t border-border px-4 py-3">
          <div className="flex items-center gap-2.5 px-1">
            <div className="w-8 h-8 rounded-full bg-green/20 text-green flex items-center justify-center text-xs font-bold shrink-0">
              {userInitials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate">{displayName}</p>
              <div className="flex items-center gap-1.5">
                <p className="text-[10px] text-text-muted truncate">{VERSION}</p>
                <StorageModeBadge />
              </div>
            </div>
            <a
              href="https://github.com/Yassinello/kebab-mcp"
              target="_blank"
              rel="noopener"
              className="text-text-muted hover:text-accent transition-colors shrink-0"
              title="GitHub repository"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
            </a>
          </div>
        </div>
      </aside>
    </>
  );
}

export function AppShell({
  children,
  title,
  subtitle,
  displayName,
  serverName,
  setupMode,
  narrow,
}: {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
  displayName?: string;
  serverName?: string;
  setupMode?: boolean;
  narrow?: boolean;
}) {
  return (
    // MOBILE-01: vertical stack (top bar + content) on < sm, horizontal
    // sidebar layout on sm+.
    <div className="flex flex-col sm:flex-row min-h-screen">
      <Sidebar displayName={displayName} serverName={serverName} setupMode={setupMode} />
      <main className="flex-1 overflow-auto min-w-0">
        <div className={`${narrow ? "max-w-3xl" : "max-w-4xl"} mx-auto px-4 sm:px-8 py-6 sm:py-10`}>
          <div className="mb-6 sm:mb-8">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{title}</h1>
            {subtitle && <p className="text-text-dim mt-1 text-sm sm:text-base">{subtitle}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
