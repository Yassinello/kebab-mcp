/**
 * 2026-11 audit (C1.5): the sidebar is the menu of a personal AI hub —
 * main group Overview, Profile, Skills, Memory, Connectors, Devices, Logs;
 * power-user pages under a collapsible "Advanced" group.
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
vi.mock("@/../app/components/storage-mode-badge", () => ({ StorageModeBadge: () => null }));

import { Sidebar, PRIMARY_NAV, ADVANCED_NAV } from "@/../app/sidebar";

beforeEach(() => {
  tab = "overview";
  localStorage.clear();
});
afterEach(() => cleanup());

describe("<Sidebar />", () => {
  it("lists the hub pages in the main group", () => {
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
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "href",
      "/config?tab=profile"
    );
    expect(screen.getByRole("link", { name: "Memory" })).toHaveAttribute(
      "href",
      "/config?tab=memory"
    );
    expect(screen.getByRole("link", { name: "Devices" })).toHaveAttribute(
      "href",
      "/config?tab=devices"
    );
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
