/**
 * @vitest-environment jsdom
 *
 * Welcome flow (audit C2.1): plain "admin key" step, "Connect your AI
 * client" ordered Claude → URL clients → other clients, an always-enabled
 * "Open my dashboard", human ritual cards, and the second-browser case.
 */
import "../components/setup";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { WelcomeShell } from "../../app/welcome/WelcomeShell";
import { WelcomeStateProvider } from "../../app/welcome/WelcomeStateContext";
import { MintStep } from "../../app/welcome/steps/mint";
import { TestStep } from "../../app/welcome/steps/test";

const TOKEN = "k".repeat(64);
const ORIGIN = "https://house.example.org";

function respond(byUrl: (url: string) => { status?: number; body: unknown }) {
  vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    const { status = 200, body } = byUrl(url);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response);
  });
}

const RITUALS = [
  {
    id: "morning-brief",
    name: "morning-brief",
    title: "Morning brief",
    description: "Use when the user starts their day or asks for a morning brief.",
    summary: "Starts your day in two minutes.",
    example: "Morning brief",
    icon: "☀️",
    installed: false,
  },
];

describe("second browser during setup", () => {
  it("explains that setup is in progress elsewhere instead of a 423 error", async () => {
    respond((url) =>
      url.includes("/api/welcome/claim")
        ? { status: 423, body: { status: "claimed-by-other" } }
        : { body: {} }
    );
    render(<WelcomeShell initialBootstrap={false} />);
    expect(
      await screen.findByText(/Setup is in progress in another browser\. Finish it there/)
    ).toBeInTheDocument();
    expect(screen.getByText("Locked out? Recover access")).toBeInTheDocument();
    expect(screen.queryByText(/Could not reach this instance/)).not.toBeInTheDocument();
    expect(screen.queryByText(/423/)).not.toBeInTheDocument();
  });
});

describe("admin key step", () => {
  it("explains the key in plain words before creating it", () => {
    render(
      <WelcomeStateProvider>
        <MintStep initialBootstrap={false} storageMode="kv" storageEphemeral={false} />
      </WelcomeStateProvider>
    );
    expect(screen.getByText("Create your admin key")).toBeInTheDocument();
    expect(screen.getByText(/admin key opens your .*dashboard/)).toBeInTheDocument();
    expect(screen.getByText(/In your password manager/)).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/bearer|64-char|cold start|MUST/i);
  });

  it("keeps the save confirmation and moves hosting details under Advanced", () => {
    render(
      <WelcomeStateProvider initial={{ token: TOKEN, instanceUrl: ORIGIN }}>
        <MintStep initialBootstrap={false} storageMode="kv" storageEphemeral={false} />
      </WelcomeStateProvider>
    );
    expect(screen.getByText("Save your admin key")).toBeInTheDocument();
    expect(screen.getByText(TOKEN)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm you saved the key" });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I saved my admin key/));
    expect(screen.getByRole("button", { name: "Continue → Connect" })).toBeEnabled();

    const advanced = screen.getByText("Download .env fragment").closest("details");
    expect(advanced).not.toBeNull();
    expect(advanced!.open).toBe(false);
    expect(advanced!.textContent).toContain("MCP_AUTH_TOKEN");
    const outside = (document.body.textContent ?? "").replace(advanced!.textContent ?? "", "");
    expect(outside).not.toMatch(/\.env|MCP_AUTH_TOKEN|Vercel|bearer|cold start/i);
  });
});

describe("connect step", () => {
  function renderConnect() {
    respond((url) =>
      url.includes("/api/welcome/starter-skills") ? { body: { skills: RITUALS } } : { body: {} }
    );
    return render(
      <WelcomeStateProvider initial={{ token: TOKEN, instanceUrl: ORIGIN, tokenSaved: true }}>
        <TestStep durableBackend />
      </WelcomeStateProvider>
    );
  }

  it("leads with Claude: Add to Claude, then the setup phrase", () => {
    renderConnect();
    const add = screen.getByRole("link", { name: "Add to Claude" });
    expect(add.getAttribute("href")).toContain(
      encodeURIComponent(`${ORIGIN}/api/mcp`).replace(/%20/g, "+")
    );
    expect(screen.getByText("Set up my Kebab House")).toBeInTheDocument();
    expect(screen.getByText(/to approve the connection/)).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Add to Claude")).toBeLessThan(
      text.indexOf("Claude Code, Cursor, ChatGPT")
    );
    expect(text.indexOf("Claude Code, Cursor, ChatGPT")).toBeLessThan(
      text.indexOf("Other clients (token)")
    );
  });

  it("gives URL clients the URL only, and other clients their own device token", () => {
    renderConnect();
    expect(screen.getAllByText(`${ORIGIN}/api/mcp`).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Add to Cursor" }).getAttribute("href")).toMatch(
      /^cursor:\/\//
    );
    expect(screen.getByText(/Devices → Add device/)).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/One token, any number of clients|paste it everywhere/);
    // The admin key itself is never offered to AI clients.
    expect(text).not.toContain(TOKEN);
  });

  it("opens the dashboard without running the test, which stays optional", async () => {
    renderConnect();
    const open = screen.getByRole("link", { name: /Open my dashboard/ });
    expect(open.getAttribute("href")).toBe(`/config?token=${TOKEN}`);
    expect(open).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(/Test your MCP connection first/)).not.toBeInTheDocument();

    respond((url) =>
      url.includes("/api/welcome/test-mcp") ? { body: { ok: true } } : { body: { skills: [] } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Run the check" }));
    expect(await screen.findByText(/Your server answered/)).toBeInTheDocument();
  });

  it("shows rituals with a human summary and the phrase to say", async () => {
    renderConnect();
    expect(await screen.findByText("Starts your day in two minutes.")).toBeInTheDocument();
    expect(screen.getByText(/Say:/).textContent).toContain("Morning brief");
    await waitFor(() =>
      expect(screen.queryByText(/Use when the user starts their day/)).not.toBeInTheDocument()
    );
  });
});
