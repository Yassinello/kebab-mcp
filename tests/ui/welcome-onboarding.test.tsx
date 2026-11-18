/**
 * @vitest-environment jsdom
 *
 * Welcome flow (audit C2.1): plain "admin key" step, "Connect Claude"
 * first (button, URL, three steps, setup phrase), other clients folded, an always-enabled
 * "Open my dashboard", human ritual cards, and the second-browser case.
 */
import "../components/setup";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
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
  function renderConnect(token: string | null = TOKEN) {
    respond((url) =>
      url.includes("/api/welcome/starter-skills") ? { body: { skills: RITUALS } } : { body: {} }
    );
    return render(
      <WelcomeStateProvider initial={{ token, instanceUrl: ORIGIN, tokenSaved: true }}>
        <TestStep durableBackend />
      </WelcomeStateProvider>
    );
  }

  it("leads with Connect Claude: the button, the URL, three steps, then the phrase", () => {
    renderConnect();
    const card = screen.getByRole("region", { name: "Connect Claude" });
    const add = within(card).getByRole("link", { name: /^Connect Claude/ });
    const href = new URL(add.getAttribute("href")!);
    expect(href.origin + href.pathname).toBe("https://claude.ai/customize/connectors");
    expect(href.searchParams.get("connectorUrl")).toBe(`${ORIGIN}/api/mcp`);
    expect(add).toHaveAttribute("target", "_blank");
    for (const step of ["Add the connector", "Authorise", "Choose the access level"]) {
      expect(within(card).getByText(step)).toBeInTheDocument();
    }
    expect(within(card).getByText("Now say this in Claude:")).toBeInTheDocument();
    expect(within(card).getByText("Set up my Kebab House")).toBeInTheDocument();
    expect(within(card).getByText(/secrets are never typed in the chat/)).toBeInTheDocument();
    // Primary path first, other clients after, closed.
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Connect Claude")).toBeLessThan(text.indexOf("Set up my Kebab House"));
    expect(text.indexOf("Set up my Kebab House")).toBeLessThan(text.indexOf("Other AI clients"));
    const others = screen.getByText(/^Other AI clients/).closest("details")!;
    expect(others.open).toBe(false);
  });

  it("links the Kebab House skill in the dashboard, signed in", () => {
    renderConnect();
    const link = screen.getByRole("link", { name: "add the Kebab House skill" });
    const url = new URL(link.getAttribute("href")!, ORIGIN);
    expect(url.pathname).toBe("/config");
    expect(url.searchParams.get("tab")).toBe("skills");
    expect(url.searchParams.get("panel")).toBe("kebab-skill");
    expect(url.searchParams.get("token")).toBe(TOKEN);
  });

  it("keeps Cursor, Claude Code, ChatGPT and token clients under Other AI clients", () => {
    renderConnect();
    const others = screen.getByText(/^Other AI clients/).closest("details")!;
    expect(within(others).getByRole("link", { name: "Add to Cursor" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^cursor:\/\//)
    );
    expect(
      within(others).getByText(`claude mcp add --transport http kebab-house ${ORIGIN}/api/mcp`)
    ).toBeInTheDocument();
    expect(within(others).getByText(/Apps & Connectors/)).toBeInTheDocument();
    expect(within(others).getByText(/Devices → Add device/)).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/One token, any number of clients|paste it everywhere/);
    // The admin key itself is never shown to paste into AI clients.
    expect(text).not.toContain(TOKEN);
  });

  it("copies the URL and the phrase", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderConnect();
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/api/mcp`));
    fireEvent.click(screen.getByRole("button", { name: "Copy phrase" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Set up my Kebab House"));
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

  it("without a key in memory, dashboard links carry no token", () => {
    renderConnect(null);
    expect(screen.getByRole("link", { name: /Open my dashboard/ })).toHaveAttribute(
      "href",
      "/config"
    );
    expect(screen.getByRole("link", { name: "add the Kebab House skill" })).toHaveAttribute(
      "href",
      "/config?tab=skills&panel=kebab-skill"
    );
  });

  it("shows rituals with a human summary and the phrase to say, folded away", async () => {
    renderConnect();
    expect(await screen.findByText("Starts your day in two minutes.")).toBeInTheDocument();
    expect(screen.getByText(/Say:/).textContent).toContain("Morning brief");
    expect(screen.getByText(/^Rituals \(optional/).closest("details")!.open).toBe(false);
    await waitFor(() =>
      expect(screen.queryByText(/Use when the user starts their day/)).not.toBeInTheDocument()
    );
  });
});
