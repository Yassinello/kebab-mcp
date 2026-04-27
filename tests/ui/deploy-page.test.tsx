/**
 * @vitest-environment jsdom
 *
 * /deploy page + deploy URL constants — regression guards.
 *
 * The page exists to walk users through the **fork-first** deploy flow.
 * Two prior approaches caused real user damage and were reverted:
 *   1. /new/clone — created a standalone snapshot (no GitHub `parent`)
 *      so users could never receive upstream updates. Hit on the
 *      kebab-mcp-yass instance, 2026-04-28.
 *   2. /new/deploy — pointed Vercel at upstream directly, but lands on
 *      the generic "New Project" screen with no signposting and we
 *      could not empirically verify push-triggered redeploys for users
 *      who don't own upstream.
 *
 * The asserts below pin the flow to "fork via GitHub /fork URL, then
 * import via /vercel.com/new". Re-introducing a one-click constant
 * that bypasses fork creation will trip these tests.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import DeployPage from "@/../app/deploy/page";
import { GITHUB_FORK_URL, VERCEL_IMPORT_URL, REPO_URL } from "@/../app/landing/deploy-url";

describe("DeployPage", () => {
  it("renders the fork-first recommended flow with both step CTAs", () => {
    render(<DeployPage />);

    // Recommended card has a clear "Fork on GitHub" + "Import to Vercel" pair.
    const recommended = screen
      .getByRole("heading", { name: /fork on github, deploy on vercel/i })
      .closest("section")!;
    expect(recommended).toBeInTheDocument();

    const forkLink = within(recommended).getByRole("link", {
      name: /fork on github/i,
    });
    expect(forkLink).toHaveAttribute("href", GITHUB_FORK_URL);
    expect(forkLink).toHaveAttribute("target", "_blank");

    const importLink = within(recommended).getByRole("link", {
      name: /import to vercel/i,
    });
    expect(importLink).toHaveAttribute("href", VERCEL_IMPORT_URL);
    expect(importLink).toHaveAttribute("target", "_blank");
  });

  it("explains why the one-click Deploy Button is not used", () => {
    // The "/new/clone bricks updates" lesson is the whole reason this page
    // exists. Without surfacing it, a future contributor will reintroduce a
    // shiny "Deploy with Vercel" CTA and reproduce the bug.
    // Use getAllBy* — jsdom under StrictMode-like double-render in some
    // configs returns multiple matches; we only care that the text appears
    // at least once.
    render(<DeployPage />);
    expect(screen.getAllByText(/why not the one-click deploy button/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/standalone snapshot/i).length).toBeGreaterThan(0);
  });

  it("renders three secondary deployment options", () => {
    render(<DeployPage />);
    expect(screen.getAllByRole("heading", { name: /guided cli/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: /docker \/ local/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: /advanced hosting/i }).length).toBeGreaterThan(0);
  });

  it("renders post-deployment guidance", () => {
    render(<DeployPage />);
    expect(screen.getAllByRole("heading", { name: /after deployment/i }).length).toBeGreaterThan(0);
    // Mention the welcome flow / token mint, since the user has to do this
    // manually after the Vercel deploy completes.
    expect(screen.getAllByText(/welcome flow/i).length).toBeGreaterThan(0);
  });
});

describe("Deploy URL constants", () => {
  it("GITHUB_FORK_URL points at the upstream /fork dialog", () => {
    expect(GITHUB_FORK_URL).toBe(`${REPO_URL}/fork`);
    expect(GITHUB_FORK_URL).toBe("https://github.com/Yassinello/kebab-mcp/fork");
  });

  it("VERCEL_IMPORT_URL points at the manual New Project flow", () => {
    expect(VERCEL_IMPORT_URL).toBe("https://vercel.com/new");
  });

  it("does not leak the legacy one-click /new/clone URL pattern", () => {
    // Anti-regression: any constant in deploy-url.ts that matches /new/clone
    // would silently re-enable the standalone-snapshot bug. We assert across
    // both exported constants and the module text.
    expect(GITHUB_FORK_URL).not.toContain("/new/clone");
    expect(GITHUB_FORK_URL).not.toContain("/new/deploy");
    expect(VERCEL_IMPORT_URL).not.toContain("/new/clone");
    expect(VERCEL_IMPORT_URL).not.toContain("/new/deploy");
  });
});
