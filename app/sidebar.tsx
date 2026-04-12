"use client";

import { usePathname } from "next/navigation";

const NAV = [
  { section: "OVERVIEW", items: [{ href: "/config", label: "Dashboard", icon: "grid" }] },
  {
    section: "CONFIGURATION",
    items: [
      { href: "/config?tab=packs", label: "Packs", icon: "package" },
      { href: "/config?tab=tools", label: "Tools", icon: "terminal" },
      { href: "/config?tab=settings", label: "Settings", icon: "settings" },
    ],
  },
];

const ICONS: Record<string, string> = {
  grid: "M4 5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5Zm10 0a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V5ZM4 15a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4Zm10 0a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4Z",
  package:
    "m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12",
  terminal: "m4 17 6-6-6-6m8 14h8",
  settings:
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
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

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Sidebar({
  displayName = "User",
  serverName = "MyMCP",
  setupMode = false,
}: {
  displayName?: string;
  serverName?: string;
  setupMode?: boolean;
}) {
  const pathname = usePathname();
  const orgInitials = getInitials(serverName);
  const userInitials = getInitials(displayName);

  return (
    <aside className="w-60 border-r border-border bg-bg-sidebar min-h-screen flex flex-col shrink-0">
      {/* Brand / Org header */}
      <div className="px-4 pt-6 pb-5">
        <p className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.12em] px-1 mb-2">
          MYMCP
        </p>
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
      <nav className="flex-1 px-4 space-y-5 overflow-y-auto">
        {NAV.map((section) => (
          <div key={section.section}>
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.12em] px-2 mb-1.5">
              {section.section}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = pathname === item.href;
                const disabled = setupMode && item.href !== "/setup";
                return (
                  <li key={item.href}>
                    <a
                      href={disabled ? undefined : item.href}
                      className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
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
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer: user profile */}
      <div className="mt-auto border-t border-border px-4 py-3">
        <div className="flex items-center gap-2.5 px-1">
          <div className="w-8 h-8 rounded-full bg-green/20 text-green flex items-center justify-center text-xs font-bold shrink-0">
            {userInitials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold truncate">{displayName}</p>
            <p className="text-[10px] text-text-muted truncate">v0.2.1</p>
          </div>
          <a
            href="https://github.com/Yassinello/mymcp"
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
    <div className="flex min-h-screen">
      <Sidebar displayName={displayName} serverName={serverName} setupMode={setupMode} />
      <main className="flex-1 overflow-auto">
        <div className={`${narrow ? "max-w-3xl" : "max-w-4xl"} mx-auto px-8 py-10`}>
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {subtitle && <p className="text-text-dim mt-1">{subtitle}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
