/**
 * @vitest-environment jsdom
 */
import "./setup";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillsTab } from "../../app/config/tabs/skills";

// Mock next/navigation — SkillsTab reads useRouter() + useSearchParams()
// (?edit=<id> deep link) and there is no app router mounted under jsdom.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/config",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock InfoTooltip to avoid transitive deps
vi.mock("../../app/config/tabs/settings/info-tooltip", () => ({
  InfoTooltip: () => <span data-testid="info-tooltip">?</span>,
}));

// Mock ImportSkillModal
vi.mock("../../app/config/tabs/skills-import-modal", () => ({
  ImportSkillModal: () => <div data-testid="import-modal">import modal</div>,
}));

describe("SkillsTab", () => {
  beforeEach(() => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, skills: [] }),
    } as unknown as Response);
  });

  it("renders the New skill button", async () => {
    render(<SkillsTab />);

    await waitFor(() => {
      // The button specifically has the text; empty state also contains it in a <strong>
      expect(screen.getByRole("button", { name: /new skill/i })).toBeInTheDocument();
    });
  });

  it("renders Import from URL button", async () => {
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /import from url/i })).toBeInTheDocument();
    });
  });

  it("renders the Agent Skills import button (SKILL.md / zip)", async () => {
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /import skill\.md or zip/i })).toBeInTheDocument();
    });
  });

  it("shows the 'use your skills in every AI client' guide", async () => {
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByText(/use your skills in every ai client/i)).toBeInTheDocument();
    });
  });

  it("shows empty state when no skills exist", async () => {
    render(<SkillsTab />);

    await waitFor(() => {
      // The empty state paragraph contains this text among its child nodes
      const emptyState = screen.getByText(/no skills defined yet/i);
      expect(emptyState).toBeInTheDocument();
    });
  });

  it("renders skill cards when skills are returned", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          skills: [
            {
              id: "weekly",
              name: "weekly-status",
              description: "Draft a weekly status report",
              content: "template body",
              arguments: [],
              source: { type: "inline" },
              createdAt: "2026-01-01",
              updatedAt: "2026-01-01",
            },
          ],
        }),
    } as unknown as Response);

    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByText("weekly-status")).toBeInTheDocument();
      expect(screen.getByText("Draft a weekly status report")).toBeInTheDocument();
    });
  });

  it("lists ritual templates with an Install button that posts to the templates route", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      const body = url.startsWith("/api/config/skills/templates")
        ? init?.method === "POST"
          ? { ok: true, id: "morning_brief", action: "created" }
          : {
              ok: true,
              templates: [
                {
                  id: "remember",
                  name: "remember",
                  title: "Remember",
                  description: "Use when the user says remember this",
                  icon: "🧠",
                  tags: ["rituals"],
                  status: "installed",
                },
                {
                  id: "morning-brief",
                  name: "morning-brief",
                  title: "Morning brief",
                  description: "Use when the user starts their day",
                  icon: "☀️",
                  tags: ["rituals"],
                  status: "available",
                },
              ],
            }
        : { ok: true, skills: [] };
      return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
    });

    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Templates" })).toBeInTheDocument();
    });
    expect(screen.getByText("Morning brief")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Installed remember" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Install morning-brief" }));
    await waitFor(() => {
      const install = calls.find(
        (c) => c.url === "/api/config/skills/templates" && c.init?.method === "POST"
      );
      expect(install).toBeDefined();
      expect(JSON.parse(String(install!.init!.body))).toEqual({ id: "morning-brief" });
    });
  });

  it("offers the master relay download with install steps in 'Use everywhere'", async () => {
    render(<SkillsTab />);

    await waitFor(() => {
      expect(screen.getByText(/use your skills in every ai client/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/use your skills in every ai client/i));
    expect(screen.getByRole("button", { name: "Master relay (.zip)" })).toBeInTheDocument();
    expect(screen.getByText("claude.ai")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
    expect(
      screen.getByText(/re-upload the relay when you add, rename or remove/i)
    ).toBeInTheDocument();
  });
});
