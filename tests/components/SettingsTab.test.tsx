/**
 * @vitest-environment jsdom
 */
import "./setup";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsTab } from "../../app/config/tabs/settings";

// Mock next/navigation — SettingsTab uses useRouter and useSearchParams
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/config",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock sub-components that would pull in too many deps
vi.mock("../../app/config/tabs/settings/mcp-install-panel", () => ({
  McpInstallPanel: () => <div data-testid="mcp-install-panel">install panel</div>,
}));

const mockConfig = {
  timezone: "Europe/Paris",
  locale: "fr-FR",
  displayName: "Test User",
  contextPath: "System/context.md",
};

function renderTab() {
  return render(
    <SettingsTab config={mockConfig} baseUrl="https://mymcp.example.com" hasAuthToken={true} />
  );
}

describe("SettingsTab", () => {
  it("renders user settings fields with plain labels and config values", () => {
    renderTab();

    // C1.5: plain labels, no env-var names on screen.
    expect(screen.getByLabelText("Your name")).toBeInTheDocument();
    expect(screen.getByLabelText("Time zone")).toBeInTheDocument();
    expect(screen.getByLabelText("Language and region")).toBeInTheDocument();
    expect(screen.queryByText("MYMCP_DISPLAY_NAME")).toBeNull();
    // …but the variable stays available as a hover hint for self-hosters.
    expect(screen.getByText("Your name").getAttribute("title")).toContain("MYMCP_DISPLAY_NAME");

    const inputs = screen.getAllByRole("textbox");
    const values = inputs.map((i) => (i as HTMLInputElement).value);
    expect(values).toContain("Test User");
    expect(values).toContain("Europe/Paris");
    expect(values).toContain("fr-FR");
  });

  it("shows the Save settings button", () => {
    renderTab();
    expect(screen.getByRole("button", { name: /save settings/i })).toBeInTheDocument();
  });

  it("renders the remaining sub-tabs; profile, devices and storage moved out", () => {
    renderTab();
    expect(screen.getByRole("button", { name: /user settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mcp install/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /advanced/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^devices$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^storage$/i })).toBeNull();
    expect(screen.queryByText(/Profile \(default\)/)).toBeNull();
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "href",
      "/config?tab=profile"
    );
  });
});
