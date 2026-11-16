/**
 * 2026-11 audit (C1.1): the Overview is about the user's hub — "Your
 * Kebab House" card, one next action, the Getting started checklist and
 * the admin-key warning (contract 2).
 */
/// <reference lib="dom" />
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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
    errors: [],
    ...overrides,
  };
}

function stubHub(body: unknown) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
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
    expect(gettingStartedSteps(h).map((s) => s.done)).toEqual([false, false, false, false]);
    expect(nextAction(h)).toMatchObject({
      label: "Connect an AI client",
      href: "/config?tab=settings&sub=mcp",
    });
  });

  it("walks the steps in order, then points to the memory", () => {
    const connected = hub({
      clients: {
        connected: 1,
        devices: 1,
        oauth: 0,
        lastActivity: null,
        list: [],
        seen: ["Claude"],
      },
    });
    expect(nextAction(connected).href).toBe("/config?tab=profile");

    const all = hub({
      profile: {
        mode: "inline",
        bytes: 10,
        updatedAt: null,
        by: null,
        filled: true,
        otherProfiles: 0,
      },
      skills: { count: 3, rituals: { installed: 1, total: 5 } },
      clients: { connected: 2, devices: 1, oauth: 1, lastActivity: null, list: [], seen: [] },
      notes: { count: 12, backend: "kv" },
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
    expect(gettingStartedSteps(p).some((s) => s.done)).toBe(false);
  });
});

describe("<HubSection />", () => {
  it("shows the hub card, one next action and the checklist for a new user", async () => {
    stubHub(hub());
    render(<HubSection />);
    expect(await screen.findByText("Getting started")).toBeInTheDocument();
    expect(screen.getByText("Your Kebab House")).toBeInTheDocument();
    // One next-action button (the checklist repeats the step as a plain link).
    const links = screen.getAllByRole("link", { name: "Connect an AI client" });
    expect(links.filter((l) => l.classList.contains("bg-accent"))).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/config?tab=settings&sub=mcp");
    expect(screen.getByText("Create your profile")).toHaveAttribute("href", "/config?tab=profile");
    expect(screen.getByText("Install a ritual")).toHaveAttribute("href", "/config?tab=skills");
    expect(screen.getByText("Connect a second AI client")).toHaveAttribute(
      "href",
      "/config?tab=devices"
    );
    expect(screen.getByText("Empty")).toBeInTheDocument();
    expect(screen.getByText("0 of 5 rituals installed")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
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
      })
    );
    render(<HubSection />);
    expect(await screen.findByText("Filled")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB · updated 2h ago by Claude")).toBeInTheDocument();
    expect(screen.getByText("2 connected")).toBeInTheDocument();
    expect(screen.queryByText("Getting started")).toBeNull();
  });

  it("warns when an AI client uses the admin key", async () => {
    stubHub(hub({ adminKeyUsedAt: new Date().toISOString() }));
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
