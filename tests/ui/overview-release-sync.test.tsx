/**
 * Overview update banner — release-sync mode (Kebab House phase 2, UPD-04).
 *
 * The dashboard must say which update mechanism is in use and, for a
 * Deploy Button clone, offer the release (not "N commits") and surface
 * conflicts returned by POST /api/config/update.
 */
/// <reference lib="dom" />
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { OverviewTab } from "@/../app/config/tabs/overview";

const props = {
  baseUrl: "http://localhost",
  totalTools: 0,
  enabledCount: 0,
  connectorCount: 0,
  logs: [],
  version: "0.1.16",
  commitSha: undefined,
  tenantId: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubFetch(getBody: unknown, postBody?: { body: unknown; status: number }) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/config/update")) {
      if (init?.method === "POST" && postBody) {
        return Promise.resolve(json(postBody.body, postBody.status));
      }
      return Promise.resolve(json(getBody));
    }
    if (url.includes("/api/admin/health-history")) return Promise.resolve(json([]));
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const AVAILABLE = {
  mode: "release-sync",
  checkedAt: new Date().toISOString(),
  available: true,
  status: "behind",
  behind_by: 4,
  ahead_by: 0,
  breaking: false,
  breakingReasons: [],
  commits: [{ sha: "abc1234", message: "feat: something", url: "https://x" }],
  totalCommits: 4,
  diffUrl: "https://github.com/Yassinello/kebab-mcp/compare/a...b",
  tokenConfigured: true,
  forkPrivate: false,
  deployedRepo: "me/kebab-house",
  installedVersion: "0.1.16",
  latestVersion: "0.1.17",
  releaseUrl: "https://github.com/Yassinello/kebab-mcp/releases/tag/v0.1.17",
  filesChanged: 12,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OverviewTab — release-sync mode", () => {
  it("shows the mode and offers the latest release", async () => {
    stubFetch(AVAILABLE);
    render(<OverviewTab {...props} />);
    expect(await screen.findByText("Kebab House v0.1.17 available")).toBeInTheDocument();
    expect(screen.getByText(/You run v0\.1\.16/)).toBeInTheDocument();
    expect(screen.getByText("Release sync (copies each upstream release)")).toBeInTheDocument();
  });

  it("lists conflicting files when the sync is refused", async () => {
    stubFetch(AVAILABLE, {
      status: 409,
      body: {
        ok: false,
        mode: "release-sync",
        reason: "conflict",
        message: "1 file was changed in me/kebab-house since v0.1.16. Nothing was written.",
        conflicts: ["src/core/auth.ts"],
        manualUrl: "https://github.com/Yassinello/kebab-mcp/compare/v0.1.16...v0.1.17",
      },
    });
    render(<OverviewTab {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await waitFor(() => expect(screen.getByText(/Nothing was written/)).toBeInTheDocument());
    expect(screen.getByText("src/core/auth.ts")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /see the changes on github/i })).toHaveAttribute(
      "href",
      "https://github.com/Yassinello/kebab-mcp/compare/v0.1.16...v0.1.17"
    );
  });

  it("says a fork uses merge-upstream", async () => {
    stubFetch({ ...AVAILABLE, mode: "github-api", available: false, status: "identical" });
    render(<OverviewTab {...props} />);
    expect(await screen.findByText("Fork sync (GitHub merge-upstream)")).toBeInTheDocument();
  });

  it("explains how to add the token when none is configured", async () => {
    stubFetch({ mode: "github-api", available: false, reason: "no-token", tokenConfigured: false });
    render(<OverviewTab {...props} />);
    expect(await screen.findByText(/Not set up — needs an update token/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add an update token/i })).toBeInTheDocument();
  });
});

// UPD-12 (docs/specs/cdc-instances-testeurs.md): without a token, the
// dashboard still says when a newer upstream release is out.
describe("OverviewTab — new release without an update token", () => {
  const NO_TOKEN = {
    mode: "github-api",
    reason: "no-token",
    tokenConfigured: false,
    configureUrl: "/config?tab=settings&sub=advanced",
    installedVersion: "0.1.16",
  };

  it("announces the release and links the token setup and the release notes", async () => {
    stubFetch({
      ...NO_TOKEN,
      available: true,
      latestVersion: "0.1.19",
      releaseUrl: "https://github.com/Yassinello/kebab-mcp/releases/tag/v0.1.19",
      checkedAt: new Date().toISOString(),
    });
    render(<OverviewTab {...props} />);
    expect(await screen.findByText("Kebab House v0.1.19 available")).toBeInTheDocument();
    expect(screen.getByText(/You run v0\.1\.16/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /what's new/i })).toHaveAttribute(
      "href",
      "https://github.com/Yassinello/kebab-mcp/releases/tag/v0.1.19"
    );
    const tokenLinks = screen.getAllByRole("link", { name: /add an update token/i });
    expect(tokenLinks.length).toBeGreaterThan(0);
    for (const link of tokenLinks) {
      expect(link).toHaveAttribute("href", "/config?tab=settings&sub=advanced");
    }
    // No install button: installing still needs the token.
    expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();
  });

  it("shows no release banner when already on the latest release", async () => {
    stubFetch({ ...NO_TOKEN, available: false, latestVersion: "0.1.16" });
    render(<OverviewTab {...props} />);
    expect(await screen.findByText(/Not set up — needs an update token/)).toBeInTheDocument();
    expect(screen.queryByText(/^Kebab House v.* available$/)).not.toBeInTheDocument();
  });
});
