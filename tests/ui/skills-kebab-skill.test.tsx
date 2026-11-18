/**
 * @vitest-environment jsdom
 *
 * Contract 3 — "the Kebab House skill" (formerly "Master relay"): a panel
 * in the Skills tab that explains what it does and how to add it, opened
 * in view by /config?tab=skills&panel=kebab-skill. Downloading it ticks
 * the Overview checklist item.
 */
import "../components/setup";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { KebabSkillPanel, SkillsEverywherePanel } from "../../app/config/tabs/skills-everywhere";
import { SkillsTab } from "../../app/config/tabs/skills";

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/config",
  useSearchParams: () => nav.params,
}));
vi.mock("../../app/config/tabs/settings/info-tooltip", () => ({
  InfoTooltip: () => <span>?</span>,
}));
vi.mock("../../app/config/tabs/skills-import-modal", () => ({
  ImportSkillModal: () => null,
}));

const scrolled: string[] = [];

beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this.id);
  });
  vi.mocked(globalThis.fetch).mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ ok: true, skills: [] }),
  } as unknown as Response);
});
afterEach(() => {
  nav.params = new URLSearchParams();
  vi.useRealTimers();
});

describe("Kebab House skill panel", () => {
  it("names it, says what it does and how to add it", () => {
    render(<KebabSkillPanel />);
    const panel = screen.getByRole("region", { name: "Add the Kebab House skill to Claude" });
    expect(panel.id).toBe("kebab-skill");
    const text = panel.textContent ?? "";
    expect(text).toMatch(/makes Claude use your profile, your skills and the Kebab House rules/);
    expect(text).toContain("Settings → Capabilities → Skills → Upload skill");
    expect(text).toContain("~/.claude/skills/");
    expect(text).not.toMatch(/master relay/i);
    expect(
      within(panel).getByRole("button", { name: "Download the Kebab House skill (.zip)" })
    ).toBeInTheDocument();
  });

  it("downloading records the checklist item and fetches the zip", async () => {
    const assigned: string[] = [];
    const location = { href: "" };
    Object.defineProperty(location, "href", {
      set: (v: string) => assigned.push(v),
      get: () => "",
    });
    vi.stubGlobal("location", location);
    render(<KebabSkillPanel tags={["perso"]} />);
    fireEvent.change(screen.getByLabelText("Limit the Kebab House skill to one tag"), {
      target: { value: "perso" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Download the Kebab House skill (.zip)" }));
    await waitFor(() => expect(assigned).toEqual(["/api/config/skills/relay-master?tag=perso"]));
    const post = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([url, init]) => url === "/api/config/hub" && init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ mark: "kebab-skill" });
  });

  it("the multi-client guide points to the panel instead of a second download", () => {
    render(<SkillsEverywherePanel />);
    fireEvent.click(screen.getByRole("button", { name: /Use your skills in every AI client/ }));
    expect(
      screen.getByRole("link", { name: "Add the Kebab House skill to Claude" })
    ).toHaveAttribute("href", "#kebab-skill");
    expect(screen.queryByRole("button", { name: /\.zip/ })).toBeNull();
  });
});

describe("/config?tab=skills&panel=kebab-skill", () => {
  it("opens the Skills tab with the panel in view, highlighted briefly", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    nav.params = new URLSearchParams("tab=skills&panel=kebab-skill");
    render(<SkillsTab />);
    const panel = await screen.findByRole("region", {
      name: "Add the Kebab House skill to Claude",
    });
    await waitFor(() => expect(scrolled).toEqual(["kebab-skill"]));
    expect(panel).toHaveAttribute("data-highlighted", "true");
    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(panel).not.toHaveAttribute("data-highlighted"));
  });

  it("lands on the 'Every AI client' tab", async () => {
    nav.params = new URLSearchParams("tab=skills&panel=kebab-skill");
    render(<SkillsTab />);
    expect(await screen.findByRole("tab", { name: "Every AI client" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("without the parameter the panel is on its tab but not scrolled to", async () => {
    nav.params = new URLSearchParams("tab=skills&sub=clients");
    render(<SkillsTab />);
    const panel = await screen.findByRole("region", {
      name: "Add the Kebab House skill to Claude",
    });
    expect(panel).not.toHaveAttribute("data-highlighted");
    expect(scrolled).toEqual([]);
  });
});
