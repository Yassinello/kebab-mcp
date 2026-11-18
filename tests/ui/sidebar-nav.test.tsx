/**
 * Redesign 2026-11: the dashboard shell follows the owner's other product.
 * Sidebar: Overview alone, then "Your hub" (Profile, Skills, Memory),
 * "Connections" (Connectors, Devices) and "Activity" (Logs); power-user
 * pages under "Advanced", pinned at the bottom. Top bar: Connect Claude,
 * help and the account chip (version and storage live in its panel).
 */
/// <reference lib="dom" />
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

let tab = "overview";
vi.mock("next/navigation", () => ({
  usePathname: () => "/config",
  useSearchParams: () => new URLSearchParams(tab === "overview" ? "" : `tab=${tab}`),
}));
vi.mock("@/../app/components/storage-mode-badge", () => ({
  StorageModeBadge: () => <span>KV</span>,
}));

import { AppShell, Sidebar, NAV_GROUPS, PRIMARY_NAV, ADVANCED_NAV } from "@/../app/sidebar";

beforeEach(() => {
  tab = "overview";
  localStorage.clear();
});
afterEach(() => cleanup());

describe("<Sidebar />", () => {
  it("groups the hub pages under small labels", () => {
    expect(NAV_GROUPS.map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([
      [null, ["Overview"]],
      ["Your hub", ["Profile", "Skills", "Memory"]],
      ["Connections", ["Connectors", "Devices"]],
      ["Activity", ["Logs"]],
    ]);
    expect(PRIMARY_NAV.map((i) => i.label)).toEqual([
      "Overview",
      "Profile",
      "Skills",
      "Memory",
      "Connectors",
      "Devices",
      "Logs",
    ]);
    expect(ADVANCED_NAV.map((i) => i.label)).toEqual([
      "Tools",
      "Playground",
      "Health",
      "Storage",
      "Documentation",
      "Settings",
    ]);
    render(<Sidebar />);
    expect(screen.getByText("Personal AI hub")).toBeInTheDocument();
    const hub = screen.getByRole("list", { name: "Your hub" });
    expect(within(hub).getByRole("link", { name: "Profile" })).toHaveAttribute(
      "href",
      "/config?tab=profile"
    );
    expect(within(hub).getByRole("link", { name: "Memory" })).toHaveAttribute(
      "href",
      "/config?tab=memory"
    );
    const connections = screen.getByRole("list", { name: "Connections" });
    expect(within(connections).getByRole("link", { name: "Devices" })).toHaveAttribute(
      "href",
      "/config?tab=devices"
    );
    expect(
      within(screen.getByRole("list", { name: "Activity" })).getByRole("link", { name: "Logs" })
    ).toBeInTheDocument();
  });

  it("marks the current page with aria-current and the beige pill", () => {
    tab = "connectors";
    render(<Sidebar />);
    const current = screen.getByRole("link", { name: "Connectors" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current.className).toContain("bg-bg-nav-active");
    expect(current.className).toContain("before:bg-accent");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("keeps Advanced collapsed by default and opens it on demand", () => {
    render(<Sidebar />);
    const toggle = screen.getByRole("button", { name: "Advanced" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Tools" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const group = document.getElementById("sidebar-advanced")!;
    expect(within(group).getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(localStorage.getItem("kebab.sidebar.advancedOpen")).toBe("1");
  });

  it("opens Advanced and marks the current page when it is an advanced page", () => {
    tab = "health";
    render(<Sidebar />);
    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getByRole("link", { name: "Health" })).toHaveAttribute("aria-current", "page");
  });
});

describe("<AppShell /> top bar", () => {
  const renderShell = () =>
    render(
      <AppShell
        title="Connectors"
        subtitle="Your services."
        displayName="Sam Rivera"
        mcpUrl="https://house.example/api/mcp"
      >
        <p>page body</p>
      </AppShell>
    );

  it("renders the page header inside the panel", () => {
    renderShell();
    expect(screen.getByRole("heading", { level: 1, name: "Connectors" })).toBeInTheDocument();
    expect(screen.getByText("Your services.")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("page body");
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
  });

  it("opens the Connect Claude card in a dialog and closes it with Escape", () => {
    renderShell();
    const open = screen.getByRole("button", { name: "Connect Claude" });
    expect(screen.queryByRole("dialog")).toBeNull();
    open.focus();
    fireEvent.click(open);
    const dialog = screen.getByRole("dialog", { name: "Connect Claude" });
    expect(dialog).toHaveTextContent("https://house.example/api/mcp");
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(open).toHaveFocus();
  });

  it("links the help icon to the documentation", () => {
    renderShell();
    expect(screen.getByRole("link", { name: "Documentation" })).toHaveAttribute(
      "href",
      "/config?tab=documentation"
    );
  });

  it("shows the account chip; its panel holds the version, storage and links", () => {
    renderShell();
    const chip = screen.getByRole("button", { name: /Sam Rivera, account menu/ });
    expect(within(chip).getByText("SR")).toBeInTheDocument();
    expect(chip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById(chip.getAttribute("aria-controls")!)!;
    expect(panel).toHaveTextContent(/v\d+\.\d+\.\d+/);
    expect(panel).toHaveTextContent("KV");
    expect(within(panel).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/config?tab=settings"
    );
    expect(within(panel).getByRole("link", { name: /GitHub repository/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles the sidebar on phones with the menu button", () => {
    renderShell();
    const menu = screen.getByRole("button", { name: "Open menu" });
    const sidebar = document.getElementById("sidebar")!;
    expect(sidebar.className).toMatch(/(^|\s)hidden(\s|$)/);
    fireEvent.click(menu);
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(sidebar.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });
});
