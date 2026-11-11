/**
 * @vitest-environment jsdom
 */
import "./setup";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
});
