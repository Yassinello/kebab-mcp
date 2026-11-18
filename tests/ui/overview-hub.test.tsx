/**
 * 2026-11 audit (C1.1): the Overview is about the user's hub — "Your
 * Kebab House" card, one next action, the Getting started checklist and
 * the admin-key warning (contract 2).
 *
 * "Set it all up from Claude": the checklist is connect a client → say the
 * setup phrase → add the Kebab House skill → a second client, and the
 * "Connect Claude" card leads until a client has connected.
 */
/// <reference lib="dom" />
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { HubSection } from "@/../app/config/tabs/overview/hub-card";
import {
  gettingStartedSteps,
  nextAction,
  parseHub,
  type HubData,
} from "@/../app/config/tabs/overview/hub-state";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MCP_URL = "https://house.example.org/api/mcp";

function hub(overrides: Partial<HubData> = {}): HubData {
  return {
    profile: {
      mode: "inline",
      bytes: 0,
      updatedAt: null,
      by: null,
      filled: false,
      otherProfiles: 0,
    },
    skills: { count: 0, rituals: { installed: 0, total: 5 } },
    clients: { connected: 0, devices: 1, oauth: 0, lastActivity: null, list: [], seen: [] },
    notes: { count: 0, backend: "kv" },
    adminKeyUsedAt: null,
    setup: { step: "interview", updatedAt: null },
    kebabSkillAddedAt: null,
    errors: [],
    ...overrides,
  };
}

const ONE_CLIENT: HubData["clients"] = {
  connected: 1,
  devices: 0,
  oauth: 1,
  lastActivity: null,
  list: [],
  seen: ["Claude"],
};

function stubHub(body: unknown, onPost?: (body: unknown) => Response) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/config/hub") && init?.method === "POST") {
      const sent: unknown = JSON.parse(String(init.body));
      return Promise.resolve(
        onPost ? onPost(sent) : json({ ok: true, kebabSkillAddedAt: "2026-11-18T09:00:00.000Z" })
      );
    }
    if (url.includes("/api/config/hub")) return Promise.resolve(json(body));
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("hub-state", () => {
  it("a fresh hub: nothing done, first action is connecting a client", () => {
    const h = hub();
    const steps = gettingStartedSteps(h);
    expect(steps.map((s) => s.id)).toEqual(["client", "setup", "kebab-skill", "second-client"]);
    expect(steps.map((s) => s.label)).toEqual([
      "Connect an AI client",
      "Say “Set up my Kebab House”",
      "Add the Kebab House skill",
      "Connect a second AI client",
    ]);
    expect(steps.map((s) => s.done)).toEqual([false, false, false, false]);
    expect(nextAction(h)).toMatchObject({
      label: "Connect an AI client",
      href: "#connect-claude",
    });
  });

  it("each item is done from its own signal", () => {
    expect(gettingStartedSteps(hub({ clients: ONE_CLIENT }))[0]!.done).toBe(true);
    // The setup phrase is done only once the onboarding reached "done".
    for (const step of ["interview", "profile", "rituals", "connectors"]) {
      expect(gettingStartedSteps(hub({ setup: { step, updatedAt: null } }))[1]!.done).toBe(false);
    }
    expect(gettingStartedSteps(hub({ setup: { step: "done", updatedAt: null } }))[1]!.done).toBe(
      true
    );
    const skill = gettingStartedSteps(hub({ kebabSkillAddedAt: "2026-11-18T09:00:00Z" }))[2]!;
    expect(skill).toMatchObject({
      done: true,
      href: "/config?tab=skills&panel=kebab-skill",
      manual: true,
    });
  });

  it("walks the steps in order, then points to the memory", () => {
    const connected = hub({ clients: ONE_CLIENT });
    // The phrase is said in the AI client: a text to copy, not a link.
    expect(nextAction(connected)).toMatchObject({
      label: "Say “Set up my Kebab House”",
      copy: "Set up my Kebab House",
    });
    expect(nextAction(connected).href).toBeUndefined();

    const setUp = hub({ clients: ONE_CLIENT, setup: { step: "done", updatedAt: null } });
    expect(nextAction(setUp)).toMatchObject({
      label: "Add the Kebab House skill",
      href: "/config?tab=skills&panel=kebab-skill",
    });

    const all = hub({
      skills: { count: 3, rituals: { installed: 1, total: 5 } },
      clients: { connected: 2, devices: 1, oauth: 1, lastActivity: null, list: [], seen: [] },
      notes: { count: 12, backend: "kv" },
      setup: { step: "done", updatedAt: null },
      kebabSkillAddedAt: "2026-11-18T09:00:00Z",
    });
    expect(gettingStartedSteps(all).every((s) => s.done)).toBe(true);
    expect(nextAction(all)).toMatchObject({
      label: "Browse your memory",
      href: "/config?tab=memory",
    });
  });

  it("the admin-key warning takes priority over everything", () => {
    expect(nextAction(hub({ adminKeyUsedAt: "2026-11-14T10:00:00Z" })).href).toBe(
      "/config?tab=devices"
    );
  });

  it("parses partial or empty bodies without throwing", () => {
    const p = parseHub({});
    expect(p.profile).toBeNull();
    expect(p.setup).toBeNull();
    expect(p.kebabSkillAddedAt).toBeNull();
    expect(gettingStartedSteps(p).some((s) => s.done)).toBe(false);
    expect(parseHub({ setup: { step: "done" } }).setup).toEqual({ step: "done", updatedAt: null });
    expect(parseHub({ setup: { step: 3 } }).setup).toBeNull();
  });
});

describe("<HubSection />", () => {
  it("leads with the Connect Claude card while no client is connected", async () => {
    stubHub(hub());
    render(<HubSection mcpUrl={MCP_URL} />);
    const card = await screen.findByRole("region", { name: "Connect Claude" });
    const button = within(card).getByRole("link", { name: /^Connect Claude/ });
    const href = new URL(button.getAttribute("href")!);
    expect(href.searchParams.get("connectorUrl")).toBe(MCP_URL);
    expect(within(card).getByText("Set up my Kebab House")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "add the Kebab House skill" })).toHaveAttribute(
      "href",
      "/config?tab=skills&panel=kebab-skill"
    );
    // The card comes before the hub summary.
    const hubTitle = screen.getByText("Your Kebab House");
    expect(card.compareDocumentPosition(hubTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The checklist's first item points at the card.
    const links = screen.getAllByRole("link", { name: "Connect an AI client" });
    expect(links.every((l) => l.getAttribute("href") === "#connect-claude")).toBe(true);
  });

  it("hides the Connect Claude card once a client has connected", async () => {
    stubHub(hub({ clients: ONE_CLIENT }));
    render(<HubSection mcpUrl={MCP_URL} />);
    await screen.findByText("Getting started");
    expect(screen.queryByRole("region", { name: "Connect Claude" })).toBeNull();
  });

  it("shows the hub card, one next action and the checklist for a new user", async () => {
    stubHub(hub());
    render(<HubSection />);
    expect(await screen.findByText("Getting started")).toBeInTheDocument();
    expect(screen.getByText("Your Kebab House")).toBeInTheDocument();
    // One next-action button (the checklist repeats the step as a plain link).
    const links = screen.getAllByRole("link", { name: "Connect an AI client" });
    expect(links.filter((l) => l.classList.contains("bg-accent"))).toHaveLength(1);
    expect(screen.getByText("Add the Kebab House skill")).toHaveAttribute(
      "href",
      "/config?tab=skills&panel=kebab-skill"
    );
    expect(screen.getByText("Connect a second AI client")).toHaveAttribute(
      "href",
      "/config?tab=devices"
    );
    // The setup phrase is not a dashboard link.
    expect(screen.getByText("Say “Set up my Kebab House”").tagName).toBe("P");
    expect(screen.getByText("Empty")).toBeInTheDocument();
    expect(screen.getByText("0 of 5 rituals installed")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("checklist states: done items are struck through, open ones offer their action", async () => {
    stubHub(hub({ clients: ONE_CLIENT, setup: { step: "done", updatedAt: null } }));
    render(<HubSection />);
    await screen.findByText("Getting started");
    const item = (id: string) => document.querySelector(`li[data-step="${id}"]`) as HTMLElement;
    expect(within(item("client")).getByText("Connect an AI client")).toHaveClass("line-through");
    expect(within(item("client")).getByText(/Done\./)).toBeInTheDocument();
    expect(within(item("setup")).getByText("Say “Set up my Kebab House”")).toHaveClass(
      "line-through"
    );
    expect(within(item("setup")).queryByRole("button")).toBeNull();
    expect(within(item("kebab-skill")).getByRole("button", { name: "I did it" })).toBeVisible();
    expect(within(item("kebab-skill")).getByText(/To do\./)).toBeInTheDocument();
    // Next action is the skill.
    const next = screen
      .getAllByRole("link", { name: "Add the Kebab House skill" })
      .filter((l) => l.classList.contains("bg-accent"));
    expect(next).toHaveLength(1);
  });

  it("copies the setup phrase from the checklist and the next action", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    stubHub(hub({ clients: ONE_CLIENT }));
    render(<HubSection />);
    await screen.findByText("Getting started");
    expect(screen.getByText(/Say “Set up my Kebab House” in Claude\./)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "Copy the phrase" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Set up my Kebab House"));
    expect(await screen.findByText("Copied ✓")).toBeInTheDocument();
  });

  it("“I did it” records the Kebab House skill and ticks the item", async () => {
    const fetchMock = stubHub(
      hub({ clients: ONE_CLIENT, setup: { step: "done", updatedAt: null } })
    );
    render(<HubSection />);
    fireEvent.click(await screen.findByRole("button", { name: "I did it" }));
    await waitFor(() =>
      expect(
        within(document.querySelector('li[data-step="kebab-skill"]') as HTMLElement).getByText(
          "Add the Kebab House skill"
        )
      ).toHaveClass("line-through")
    );
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/config/hub");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ mark: "kebab-skill" });
  });

  it("says so when “I did it” cannot be saved", async () => {
    stubHub(hub({ clients: ONE_CLIENT }), () => json({ ok: false }, 500));
    render(<HubSection />);
    fireEvent.click(await screen.findByRole("button", { name: "I did it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save that");
  });

  it("can dismiss the checklist, and remembers it", async () => {
    stubHub(hub());
    const { unmount } = render(<HubSection />);
    fireEvent.click(await screen.findByText("Hide this list"));
    expect(screen.queryByText("Getting started")).toBeNull();
    unmount();
    render(<HubSection />);
    await screen.findByText("Empty");
    expect(screen.queryByText("Getting started")).toBeNull();
  });

  it("hides the checklist when every step is done and shows profile details", async () => {
    stubHub(
      hub({
        profile: {
          mode: "inline",
          bytes: 2048,
          updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
          by: "Claude",
          filled: true,
          otherProfiles: 0,
        },
        skills: { count: 4, rituals: { installed: 2, total: 5 } },
        clients: { connected: 2, devices: 1, oauth: 1, lastActivity: null, list: [], seen: [] },
        notes: { count: 7, backend: "kv" },
        setup: { step: "done", updatedAt: null },
        kebabSkillAddedAt: "2026-11-18T09:00:00Z",
      })
    );
    render(<HubSection />);
    expect(await screen.findByText("Filled")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB · updated 2h ago by Claude")).toBeInTheDocument();
    expect(screen.getByText("2 connected")).toBeInTheDocument();
    expect(screen.queryByText("Getting started")).toBeNull();
  });

  it("warns when an AI client uses the admin key", async () => {
    stubHub(hub({ clients: ONE_CLIENT, adminKeyUsedAt: new Date().toISOString() }));
    render(<HubSection />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "An AI client uses your admin key. Give it its own device token (Devices → Add device), so it cannot approve its own messages."
    );
    expect(screen.getByRole("link", { name: "Open Devices" })).toHaveAttribute(
      "href",
      "/config?tab=devices"
    );
  });
});
