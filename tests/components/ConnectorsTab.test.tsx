/**
 * @vitest-environment jsdom
 */
import "./setup";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConnectorsTab } from "../../app/config/tabs/connectors";
import type { ConnectorSummary } from "../../app/config/tabs";

// Mock next/navigation — ConnectorsTab calls useRouter() for router.refresh()
// after a successful save. The default jest-style App-Router mock isn't
// available in component-test mode, so provide a minimal stub.
const refreshMock = vi.fn();
// Contract 1 deep link: tests set `nav.params` to simulate ?connector=<id>.
const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => nav.params,
}));

// Mock ApiConnectionsSection which makes its own fetch calls — keep this
// component test focused on the ConnectorsTab logic.
vi.mock("../../app/config/tabs/api-connections-section", () => ({
  ApiConnectionsSection: () => null,
}));

// Mock the wizard module which ConnectorsTab imports for PACKS / CredentialInput
vi.mock("../../app/config/pack-defs", () => ({
  PACKS: [
    {
      id: "google",
      label: "Google Workspace",
      vars: [{ key: "GOOGLE_CLIENT_ID", label: "Client ID" }],
    },
    {
      id: "vault",
      label: "Obsidian Vault",
      vars: [{ key: "GITHUB_PAT", label: "GitHub PAT" }],
    },
  ],
  CredentialInput: ({
    v,
    value,
    onChange,
  }: {
    v: { key: string; label: string };
    value: string;
    onChange: (v: string) => void;
  }) => (
    <input data-testid={`cred-${v.key}`} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
  normalizeGitHubRepo: (v: string) => v,
}));

// Mock renderMarkdown to avoid pulling in the real module
vi.mock("@/core/markdown-lite", () => ({
  renderMarkdown: (src: string) => `<p>${src}</p>`,
}));

const mockConnectors: ConnectorSummary[] = [
  {
    id: "google",
    label: "Google Workspace",
    description: "Gmail, Calendar, Drive, Contacts",
    enabled: true,
    reason: "",
    toolCount: 18,
    requiredEnvVars: ["GOOGLE_CLIENT_ID"],
    tools: [
      { name: "gmail_search", description: "Search emails", destructive: false },
      { name: "calendar_events", description: "List events", destructive: false },
    ],
  },
  {
    id: "vault",
    label: "Obsidian Vault",
    description: "Read/write vault notes",
    enabled: false,
    reason: "missing env vars: GITHUB_PAT",
    toolCount: 15,
    requiredEnvVars: ["GITHUB_PAT"],
    tools: [{ name: "vault_read", description: "Read a note", destructive: false }],
  },
];

describe("ConnectorsTab", () => {
  beforeEach(() => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, vars: { GOOGLE_CLIENT_ID: "xxx" } }),
    } as unknown as Response);
  });

  it("renders connector names and the Active badge for enabled packs", async () => {
    render(<ConnectorsTab connectors={mockConnectors} />);

    await waitFor(() => {
      expect(screen.getByText("Google Workspace")).toBeInTheDocument();
      expect(screen.getByText("Obsidian Vault")).toBeInTheDocument();
    });

    // Redesign 2026-11: each row carries a status dot with its label.
    expect(document.getElementById("connector-google")).toHaveTextContent("Active");
    expect(document.getElementById("connector-vault")).toHaveTextContent("Needs setup");
  });

  it("filters rows with the All · Active · Needs setup tabs", async () => {
    const withOff: ConnectorSummary[] = [
      ...mockConnectors,
      {
        id: "webhook",
        label: "Webhook Receiver",
        description: "Receive payloads",
        enabled: false,
        reason: "disabled by MYMCP_DISABLE_WEBHOOK",
        toolCount: 2,
        requiredEnvVars: [],
        tools: [],
      },
    ];
    render(<ConnectorsTab connectors={withOff} />);
    const all = await screen.findByRole("tab", { name: /^All/ });
    expect(all).toHaveAttribute("aria-selected", "true");
    expect(all).toHaveTextContent("3");
    expect(document.getElementById("connector-webhook")).toHaveTextContent("Off");

    fireEvent.click(screen.getByRole("tab", { name: /^Active/ }));
    expect(screen.getByRole("tab", { name: /^Active/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Google Workspace")).toBeInTheDocument();
    expect(screen.queryByText("Obsidian Vault")).toBeNull();
    expect(screen.queryByText("Webhook Receiver")).toBeNull();
    expect(window.location.search).toContain("sub=active");

    fireEvent.click(screen.getByRole("tab", { name: /^Needs setup/ }));
    expect(screen.getByText("Obsidian Vault")).toBeInTheDocument();
    expect(screen.queryByText("Google Workspace")).toBeNull();

    // Arrow keys move between tabs.
    fireEvent.keyDown(screen.getByRole("tab", { name: /^Needs setup/ }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /^All/ })).toHaveAttribute("aria-selected", "true");
    expect(window.location.search).not.toContain("sub=");
  });

  it("opens a row in place with its chevron", async () => {
    render(<ConnectorsTab connectors={mockConnectors} />);
    const chevron = await screen.findByRole("button", {
      name: "Show details for Obsidian Vault",
    });
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chevron);
    const hide = screen.getByRole("button", { name: "Hide details for Obsidian Vault" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    const details = document.getElementById(hide.getAttribute("aria-controls")!)!;
    expect(details).toHaveClass("max-h-[4000px]");
    expect(details).toHaveTextContent("Why it is off: missing env vars: GITHUB_PAT");
    fireEvent.click(hide);
    expect(details).toHaveClass("max-h-0");
  });

  it("expands a connector on click to show tools", async () => {
    render(<ConnectorsTab connectors={mockConnectors} />);

    await waitFor(() => {
      expect(screen.getByText("Google Workspace")).toBeInTheDocument();
    });

    // Click the Google Workspace card to expand it — use getAllByText since
    // it may render twice (collapsed + expanded)
    fireEvent.click(screen.getAllByText("Google Workspace")[0]!);

    // The tools list should now be visible (inside an expanded section)
    await waitFor(() => {
      expect(screen.getByText("gmail_search")).toBeInTheDocument();
      expect(screen.getByText("calendar_events")).toBeInTheDocument();
    });
  });

  it("shows tool count for enabled connectors only", async () => {
    render(<ConnectorsTab connectors={mockConnectors} />);

    await waitFor(() => {
      // Only enabled packs render their tool count in the header (visual-noise
      // cleanup, 2718209). Google is enabled → "18 tools" appears. Vault is
      // disabled → "15 tools" must NOT appear in the header.
      expect(screen.getAllByText(/18\s*tools/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/15\s*tools/)).toBeNull();
    });
  });
});

// User-reported regression suite (2026-04-29):
// On Browser/Paywall connectors with already-saved (masked) credentials,
// clicking Save without editing any field returned silently — no toast,
// no error, no toggle change. The user assumed the save was broken.
// These tests pin the new feedback paths so the silent-return can't
// reappear.
describe("ConnectorsTab — Save feedback (2026-04-29 regression)", () => {
  // Route-aware fetch mock: ConnectorsTab fires both /api/config/env
  // (creds) and /api/storage/status (mode/ephemeral) on mount. Returning
  // a single resolved-once mock for the first call would leave the second
  // hitting the unmocked global fetch → render stays on "Loading…".
  function mockTabFetches(envVars: Record<string, string>) {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/config/env")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, vars: envVars }),
        } as unknown as Response);
      }
      if (url.includes("/api/storage/status")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ mode: "kv", ephemeral: false, error: null }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      } as unknown as Response);
    });
  }

  // Click the header of one card to expand it. Cards stay in the DOM
  // when collapsed (max-h transition rather than unmount), so we need
  // to wait for at least one Save button to be present before acting.
  async function openCard(label: string) {
    await waitFor(() => expect(screen.getByText(label)).toBeInTheDocument());
    const headers = screen.getAllByText(label);
    fireEvent.click(headers[0]!);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^Save$/ }).length).toBeGreaterThan(0)
    );
  }

  // Save button click without typing into any field — the silent-return path.
  it("surfaces 'No changes to save' when Save is clicked with no edits on an already-configured pack", async () => {
    // Google moved to the multi-account selector in v0.19 (no legacy Save
    // button in KV mode), so exercise the legacy single-token path on an
    // already-configured Obsidian Vault pack instead.
    mockTabFetches({ GITHUB_PAT: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022" });
    const configured = mockConnectors.map((c) =>
      c.id === "vault" ? { ...c, enabled: true, reason: "" } : c
    );

    render(<ConnectorsTab connectors={configured} />);
    await openCard("Obsidian Vault");

    const buttons = screen.getAllByRole("button", { name: /^Save$/ });
    fireEvent.click(buttons[buttons.length - 1]!);

    await waitFor(() => {
      expect(screen.getByText(/No changes to save/i)).toBeInTheDocument();
    });
  });

  // Save with no edits on an unconfigured pack should also surface a clear hint.
  it("surfaces 'Fill in at least one credential' on an unconfigured pack with no edits", async () => {
    mockTabFetches({});

    render(<ConnectorsTab connectors={mockConnectors} />);
    await openCard("Obsidian Vault");

    // Vault is the second card; openCard expanded it but two Save buttons
    // exist in the DOM (Google's hidden card + Vault's visible one). The
    // visible one is the second in document order.
    const buttons = screen.getAllByRole("button", { name: /^Save$/ });
    fireEvent.click(buttons[buttons.length - 1]!);

    await waitFor(() => {
      expect(screen.getByText(/Fill in at least one credential/i)).toBeInTheDocument();
    });
  });
});

// Contract 1: /config?tab=connectors&connector=<packId> — the link Claude
// sends during setup so the owner enters secrets in the dashboard.
describe("ConnectorsTab — connector deep link", () => {
  const withExtras: ConnectorSummary[] = [
    ...mockConnectors,
    {
      id: "linear",
      label: "Linear",
      description: "Issues",
      enabled: false,
      reason: "missing env vars: LINEAR_API_KEY",
      toolCount: 3,
      requiredEnvVars: ["LINEAR_API_KEY"],
      tools: [],
    },
    {
      id: "skills",
      label: "Skills",
      description: "Core",
      enabled: true,
      reason: "",
      toolCount: 4,
      requiredEnvVars: [],
      tools: [],
      core: true,
    },
  ];
  const scrolled: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    scrolled.length = 0;
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this.id);
    });
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, vars: {} }),
    } as unknown as Response);
  });

  afterEach(() => {
    nav.params = new URLSearchParams();
    vi.useRealTimers();
  });

  const card = (id: string) => document.getElementById(`connector-${id}`)!;
  const isOpen = (id: string) =>
    card(id).querySelector(".max-h-\\[4000px\\]") !== null &&
    card(id).querySelector(".max-h-0") === null;

  it("scrolls to the card, highlights it briefly and opens its credential form", async () => {
    nav.params = new URLSearchParams("tab=connectors&connector=vault");
    render(<ConnectorsTab connectors={withExtras} />);
    await waitFor(() => expect(card("vault")).toHaveAttribute("data-highlighted", "true"));
    expect(isOpen("vault")).toBe(true);
    expect(isOpen("google")).toBe(false);
    expect(screen.getByTestId("cred-GITHUB_PAT")).toBeInTheDocument();
    await waitFor(() => expect(scrolled).toContain("connector-vault"));
    expect(card("vault")).toHaveTextContent(
      "When you’re done, go back to your AI conversation and say “done”."
    );
    // The highlight fades; the note stays.
    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(card("vault")).not.toHaveAttribute("data-highlighted"));
    expect(screen.getAllByRole("note")).toHaveLength(1);
    expect(screen.getByRole("note")).toHaveTextContent(/say “done”/);
  });

  it("lands on the All tab even when another tab is in the link", async () => {
    nav.params = new URLSearchParams("tab=connectors&sub=active&connector=vault");
    render(<ConnectorsTab connectors={withExtras} />);
    await waitFor(() => expect(card("vault")).toHaveAttribute("data-highlighted", "true"));
    expect(screen.getByRole("tab", { name: /^All/ })).toHaveAttribute("aria-selected", "true");
    expect(isOpen("vault")).toBe(true);
  });

  it("highlights a connector without a credential form but does not open it", async () => {
    nav.params = new URLSearchParams("tab=connectors&connector=linear");
    render(<ConnectorsTab connectors={withExtras} />);
    await waitFor(() => expect(card("linear")).toHaveAttribute("data-highlighted", "true"));
    expect(isOpen("linear")).toBe(false);
    expect(card("linear")).toHaveTextContent(/say “done”/);
  });

  it("an unknown or hidden id leaves the tab as usual", async () => {
    for (const id of ["nope", "skills"]) {
      nav.params = new URLSearchParams(`tab=connectors&connector=${id}`);
      const { unmount } = render(<ConnectorsTab connectors={withExtras} />);
      await waitFor(() => expect(screen.getByText("Google Workspace")).toBeInTheDocument());
      await vi.advanceTimersByTimeAsync(50);
      expect(document.querySelector("[data-highlighted]")).toBeNull();
      expect(screen.queryByRole("note")).toBeNull();
      expect(scrolled).toEqual([]);
      expect(isOpen("google")).toBe(false);
      expect(isOpen("vault")).toBe(false);
      unmount();
    }
  });

  it("without the parameter nothing is opened or highlighted", async () => {
    render(<ConnectorsTab connectors={withExtras} />);
    await waitFor(() => expect(screen.getByText("Google Workspace")).toBeInTheDocument());
    expect(document.querySelector("[data-highlighted]")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });
});
