/**
 * Phase 063 CRON-03 — Refresh icon UI test.
 *
 * Asserts:
 *   - Banner renders 'checked Xh ago' when checkedAt is present in payload
 *   - Refresh button (aria-label="Refresh update check") is rendered
 *   - Click triggers fetch('/api/config/update?force=1')
 *   - Button is disabled while in-flight (debounce + refreshing flag)
 *   - Second click while disabled does NOT trigger another fetch
 *
 * W3 fix: uses `vi.useFakeTimers({ toFake: ["Date"] })` so the
 * 30s debounce assertion is deterministic — only the Date constructor
 * is faked, microtasks (used by RTL waitFor) stay real.
 *
 * URL-based fetch mock pattern: OverviewTab now renders only
 * ConnectorHealthWidget alongside the update widget — each fires its
 * own fetch. We route every URL to a stub response and only count
 * and assert on /api/config/update calls. ConnectorHealthWidget also
 * auto-triggers a deep health check on first empty state, so its
 * /api/health?deep=1 endpoint is stubbed too.
 */
/// <reference lib="dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { OverviewTab } from "@/../app/config/tabs/overview";

function defaultProps() {
  return {
    baseUrl: "http://localhost",
    totalTools: 0,
    enabledCount: 0,
    connectorCount: 0,
    logs: [],
    config: { displayName: "Test", timezone: "UTC", locale: "en-US" } as never,
    version: "0.15.0",
    commitSha: undefined,
    tenantId: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a fetch mock that handles widget noise and routes
 * /api/config/update calls to the supplied generator (one body per
 * call, in order). Returns the mock + a counter of update calls.
 */
function mockFetchRouter(updateBodies: unknown[], options?: { hangSecondCall?: boolean }) {
  let updateCallIndex = 0;
  const updateCalls: Array<string | URL | Request> = [];
  let hangResolver: ((v: Response) => void) | undefined;

  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : ((input as Request).url ?? String(input));

    // /api/config/update routes — assert against these
    if (url.includes("/api/config/update")) {
      updateCalls.push(input);
      const idx = updateCallIndex++;
      if (options?.hangSecondCall && idx === 1) {
        return new Promise<Response>((resolve) => {
          hangResolver = resolve;
        });
      }
      const body = updateBodies[idx] ?? { mode: "github-api", available: false };
      return Promise.resolve(jsonResponse(body));
    }

    // Widget endpoints — return permissive empty bodies that match
    // each widget's expected shape so the widgets settle without errors.
    if (url.includes("/api/admin/health-history")) {
      // ConnectorHealthWidget shape — empty array → "empty" state
      return Promise.resolve(jsonResponse([]));
    }
    if (url.includes("/api/health")) {
      // /api/health?deep=1 fired by ConnectorHealthWidget's auto-check
      // on first empty state. Body shape doesn't matter for these tests
      // — we just need it to resolve so the widget stops "checking".
      return Promise.resolve(
        jsonResponse({
          ok: true,
          version: "0.1.15",
          bootstrap: { state: "active" },
          kv: { reachable: true, lastRehydrateAt: null },
        })
      );
    }

    // Default — empty success (catches any other unexpected fetches)
    return Promise.resolve(jsonResponse({}));
  });

  return {
    fn,
    updateCalls,
    resolveHang: (body: unknown) => hangResolver?.(jsonResponse(body)),
  };
}

describe("OverviewTab Refresh icon (CRON-03)", () => {
  const NOW = new Date("2026-04-26T12:00:00Z").getTime();

  beforeEach(() => {
    // W3 fix: freeze Date.now() so the debounce assertion is deterministic.
    // Use the narrow `toFake: ["Date"]` form to avoid faking setTimeout
    // (React Testing Library's waitFor uses real microtasks).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup(); // unmount React tree between tests so duplicate buttons don't leak
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders 'checked Xh ago' indicator and Refresh button when checkedAt is present", async () => {
    const oneHourAgo = new Date(NOW - 60 * 60_000).toISOString();
    const router = mockFetchRouter([
      {
        mode: "github-api",
        available: false,
        behind_by: 0,
        ahead_by: 0,
        status: "identical",
        breaking: false,
        breakingReasons: [],
        commits: [],
        totalCommits: 0,
        tokenConfigured: true,
        forkPrivate: false,
        checkedAt: oneHourAgo,
      },
    ]);
    vi.stubGlobal("fetch", router.fn);

    render(<OverviewTab {...defaultProps()} />);

    await waitFor(() => {
      expect(screen.getByText(/Up to date with upstream/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/1h ago/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh update check/i })).toBeInTheDocument();
  });

  it("clicking Refresh fetches /api/config/update?force=1", async () => {
    const oneHourAgo = new Date(NOW - 60 * 60_000).toISOString();
    const sharedBody = {
      mode: "github-api",
      available: false,
      behind_by: 0,
      ahead_by: 0,
      status: "identical",
      breaking: false,
      breakingReasons: [],
      commits: [],
      totalCommits: 0,
      tokenConfigured: true,
      forkPrivate: false,
      checkedAt: oneHourAgo,
    };
    const router = mockFetchRouter([
      sharedBody,
      { ...sharedBody, checkedAt: new Date(NOW).toISOString() },
    ]);
    vi.stubGlobal("fetch", router.fn);

    render(<OverviewTab {...defaultProps()} />);

    const btn = await screen.findByRole("button", { name: /refresh update check/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(router.updateCalls.length).toBe(2);
    });
    const secondCallUrl =
      typeof router.updateCalls[1] === "string"
        ? router.updateCalls[1]
        : String(router.updateCalls[1]);
    expect(secondCallUrl).toContain("/api/config/update?force=1");
  });

  it("disables the Refresh button while a refresh is in-flight", async () => {
    const oneHourAgo = new Date(NOW - 60 * 60_000).toISOString();
    const sharedBody = {
      mode: "github-api",
      available: false,
      behind_by: 0,
      ahead_by: 0,
      status: "identical",
      breaking: false,
      breakingReasons: [],
      commits: [],
      totalCommits: 0,
      tokenConfigured: true,
      forkPrivate: false,
      checkedAt: oneHourAgo,
    };
    const router = mockFetchRouter([sharedBody, sharedBody], { hangSecondCall: true });
    vi.stubGlobal("fetch", router.fn);

    render(<OverviewTab {...defaultProps()} />);

    const btn = await screen.findByRole("button", { name: /refresh update check/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(btn).toBeDisabled();
    });
    // Second click should NOT trigger a third fetch (frozen clock keeps debounce active)
    fireEvent.click(btn);
    expect(router.updateCalls.length).toBe(2);

    // Cleanup: resolve the hung promise so the test runner doesn't leak
    router.resolveHang({
      mode: "github-api",
      available: false,
      status: "identical",
      checkedAt: new Date(NOW).toISOString(),
      tokenConfigured: true,
    });
  });
});
