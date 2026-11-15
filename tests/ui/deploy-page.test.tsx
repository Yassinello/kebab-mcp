/**
 * @vitest-environment jsdom
 *
 * /deploy page + deploy URL constants — regression guards.
 *
 * Kebab House phase 2 (DEP-01..05): the Vercel Deploy Button is the
 * recommended path again. It was dropped in April 2026 because the repo it
 * creates is not a fork and the dashboard could only update forks
 * (merge-upstream). Release sync (src/core/release-sync.ts) now updates
 * those copies, so the button is safe. Fork + Import stays documented as
 * the alternative; Docker / CLI are unchanged.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import DeployPage from "@/../app/deploy/page";
import {
  GITHUB_FORK_URL,
  VERCEL_IMPORT_URL,
  VERCEL_DEPLOY_BUTTON_URL,
  REPO_URL,
} from "@/../app/landing/deploy-url";

describe("DeployPage", () => {
  afterEach(cleanup);

  it("recommends the one-click Deploy Button and says what it creates", () => {
    render(<DeployPage />);

    const recommended = screen
      .getByRole("heading", { name: /deploy on vercel in one click/i })
      .closest("section")!;
    const button = within(recommended).getByRole("link", { name: /deploy with vercel/i });
    expect(button).toHaveAttribute("href", VERCEL_DEPLOY_BUTTON_URL);
    expect(button).toHaveAttribute("target", "_blank");
    expect(within(recommended).getByText(/recommended/i)).toBeInTheDocument();

    // What gets created + what remains (DEP-02).
    expect(within(recommended).getByText(/a copy of the code/i)).toBeInTheDocument();
    expect(within(recommended).getByText(/a vercel project/i)).toBeInTheDocument();
    expect(within(recommended).getByText(/free upstash redis database/i)).toBeInTheDocument();
    expect(within(recommended).getByText(/an update token/i)).toBeInTheDocument();
  });

  it("keeps Fork + Import as a documented alternative", () => {
    render(<DeployPage />);
    const alt = screen
      .getByRole("heading", { name: /fork on github, deploy on vercel/i })
      .closest("section")!;
    expect(within(alt).getByRole("link", { name: /fork on github/i })).toHaveAttribute(
      "href",
      GITHUB_FORK_URL
    );
    expect(within(alt).getByRole("link", { name: /import to vercel/i })).toHaveAttribute(
      "href",
      VERCEL_IMPORT_URL
    );
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

  it("VERCEL_DEPLOY_BUTTON_URL is the /new/clone flow", () => {
    expect(VERCEL_DEPLOY_BUTTON_URL.startsWith("https://vercel.com/new/clone?")).toBe(true);
  });
});
