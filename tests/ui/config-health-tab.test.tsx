/**
 * @vitest-environment jsdom
 *
 * OBS-05: /config Health tab UI test.
 *
 * Closes .planning/milestones/v0.10-durability-ROADMAP.md Phase 38 OBS-05.
 * Verifies: tab renders bootstrap state + KV reachability + rehydrate
 * counter + env presence on the happy path; falls back to "admin auth
 * required" when /api/admin/status returns 401.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HealthTab } from "@/../app/config/tabs/health";

function mockFetch(
  handlers: Partial<{
    health: () => unknown;
    adminStatus: () => { status?: number; body: unknown };
  }>
) {
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : ((input as Request).url ?? String(input));
    if (url.includes("/api/health")) {
      const body = handlers.health?.() ?? {
        ok: true,
        version: "0.10.0",
        bootstrap: { state: "active" },
        kv: { reachable: true, lastRehydrateAt: "2026-04-20T12:00:00.000Z" },
      };
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);
    }
    if (url.includes("/api/admin/status")) {
      const { status, body } = handlers.adminStatus?.() ?? {
        status: 200,
        body: {
          firstRun: {
            rehydrateCount: { total: 5, last24h: 2 },
            kvLatencySamples: [{ at: "2026-04-20T12:00:00.000Z", op: "set", durationMs: 23 }],
            envPresent: {
              UPSTASH_REDIS_REST_URL: true,
              MCP_AUTH_TOKEN: true,
              ADMIN_AUTH_TOKEN: false,
            },
          },
        },
      };
      return Promise.resolve({
        status: status ?? 200,
        ok: (status ?? 200) < 400,
        json: () => Promise.resolve(body),
      } as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  }) as typeof fetch;
}

describe("HealthTab (OBS-05)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders bootstrap state, kv reachability, rehydrate count, and env presence", async () => {
    mockFetch({});
    render(<HealthTab />);

    await waitFor(() => {
      expect(screen.getByText(/Bootstrap state/i)).toBeDefined();
      expect(screen.getByText(/active/i)).toBeDefined();
      // "reachable" appears both as the label and the status badge → allow either
      expect(screen.getAllByText(/reachable/i).length).toBeGreaterThan(0);
      // Total rehydrate count (5)
      expect(screen.getByText("5")).toBeDefined();
      // Env var name rendered
      expect(screen.getByText("UPSTASH_REDIS_REST_URL")).toBeDefined();
    });
  });

  it("shows 'admin auth required' when /api/admin/status returns 401", async () => {
    mockFetch({
      adminStatus: () => ({ status: 401, body: {} }),
    });
    render(<HealthTab />);
    // Multiple blocks say "admin auth required"; at least one must be present.
    await waitFor(() => {
      const nodes = screen.getAllByText(/admin auth required/i);
      expect(nodes.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders warnings[] when /api/health returns destructive-var alerts", async () => {
    mockFetch({
      health: () => ({
        ok: true,
        version: "0.10.0",
        bootstrap: { state: "active" },
        kv: { reachable: true, lastRehydrateAt: null },
        warnings: [
          {
            code: "DESTRUCTIVE_ENV_VAR_ACTIVE",
            var: "MYMCP_RECOVERY_RESET",
            message: "MYMCP_RECOVERY_RESET is set; recovery reset fires on every cold lambda.",
          },
        ],
      }),
    });
    render(<HealthTab />);
    await waitFor(() => {
      // MYMCP_RECOVERY_RESET appears in both warnings block + env-present list
      expect(screen.getAllByText(/MYMCP_RECOVERY_RESET/).length).toBeGreaterThan(0);
    });
  });
});
