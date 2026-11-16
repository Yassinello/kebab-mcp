/**
 * D4 (2026-11 audit) — local / Docker first-run lockout.
 *
 * Scenario: an instance without Upstash and without MCP_AUTH_TOKEN in env.
 * /welcome mints the token (first-run/bootstrap.ts writes it to the
 * filesystem KV and to /tmp), the MCP endpoint works, but the proxy only
 * looked in Upstash, so /config kept redirecting to /welcome.
 *
 * These tests mint the token with the REAL bootstrap code, then run the
 * REAL proxy (no mock of first-run-edge) and check the redirect decision.
 * TMPDIR and MYMCP_KV_PATH point at a private directory so the /tmp
 * bootstrap file and the KV file never collide with other test files.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { NextRequest } from "next/server";

const TRACKED = [
  "MCP_AUTH_TOKEN",
  "ADMIN_AUTH_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "INSTANCE_MODE",
  "VERCEL",
  "MYMCP_KV_PATH",
  "TMPDIR",
];
const saved: Record<string, string | undefined> = {};
let dir: string;

function makeRequest(url: string, cookie?: string): NextRequest {
  const req = new Request(url, { headers: cookie ? { cookie } : {} });
  const cookies = new Map<string, { value: string }>();
  if (cookie) {
    const [k, v] = cookie.split("=");
    cookies.set(k!, { value: v! });
  }
  return Object.assign(req, {
    nextUrl: new URL(url),
    cookies: { get: (k: string) => cookies.get(k) },
  }) as unknown as NextRequest;
}

async function freshModules() {
  vi.resetModules();
  const kvStore = await import("@/core/kv-store");
  kvStore.resetKVStoreCache();
  const firstRun = await import("@/core/first-run");
  const edge = await import("@/core/first-run-edge");
  const { proxy } = await import("../../proxy");
  return { firstRun, edge, proxy };
}

beforeEach(() => {
  for (const k of TRACKED) saved[k] = process.env[k];
  for (const k of TRACKED) delete process.env[k];
  dir = mkdtempSync(join(os.tmpdir(), "kebab-d4-"));
  process.env.TMPDIR = dir; // os.tmpdir() → private /tmp for the bootstrap file
  process.env.MYMCP_KV_PATH = join(dir, "kv.json");
});

afterEach(() => {
  for (const k of TRACKED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("D4 — proxy sees a token persisted by the local first-run bootstrap", () => {
  it("redirects /config to /welcome before anything was minted", async () => {
    const { proxy } = await freshModules();
    const res = await proxy(makeRequest("https://local.test/config"));
    expect(res.headers.get("location") ?? "").toContain("/welcome");
  });

  it("after /welcome minted the token (filesystem KV), /config is no longer sent to /welcome", async () => {
    const { firstRun, edge, proxy } = await freshModules();
    const { token } = firstRun.bootstrapToken("claim-d4-local-0001");
    await firstRun.flushBootstrapToKv();
    expect(existsSync(join(dir, "kv.json"))).toBe(true);
    // Only the durable file is left (as after a container restart > 15 min).
    const tmpFile = join(dir, ".mymcp-bootstrap.json");
    if (existsSync(tmpFile)) unlinkSync(tmpFile);

    // Signed out: the sign-in page, not the welcome wizard.
    const anon = await proxy(makeRequest("https://local.test/config"));
    expect(anon.headers.get("location") ?? "").not.toContain("/welcome");
    expect(anon.status).toBe(401);
    expect(edge.getEdgeBootstrapAuthToken()).toBe(token);

    // Signed in with the minted token: through to the dashboard.
    const authed = await proxy(
      makeRequest("https://local.test/config", `kebab_admin_token=${token}`)
    );
    expect(authed.headers.get("location")).toBeNull();
    expect(authed.status).toBe(200);
  });

  it("reads the /tmp bootstrap file within its 15-minute lifetime only", async () => {
    process.env.MYMCP_KV_PATH = join(dir, "absent", "kv.json");
    const tmpFile = join(dir, ".mymcp-bootstrap.json");
    const token = "a".repeat(64);

    writeFileSync(
      tmpFile,
      JSON.stringify({ claimId: "c", token, createdAt: Date.now() - 20 * 60 * 1000 })
    );
    let m = await freshModules();
    await m.edge.ensureBootstrapRehydratedFromUpstash();
    expect(m.edge.getEdgeBootstrapAuthToken()).toBeNull();

    writeFileSync(tmpFile, JSON.stringify({ claimId: "c", token, createdAt: Date.now() }));
    m = await freshModules();
    await m.edge.ensureBootstrapRehydratedFromUpstash();
    expect(m.edge.getEdgeBootstrapAuthToken()).toBe(token);
  });

  it("ignores the filesystem KV on Vercel (ephemeral there) and a malformed file", async () => {
    writeFileSync(
      join(dir, "kv.json"),
      JSON.stringify({
        "mymcp:firstrun:bootstrap": JSON.stringify({
          claimId: "c",
          token: "b".repeat(64),
          createdAt: 1,
        }),
      })
    );
    process.env.VERCEL = "1";
    let m = await freshModules();
    await m.edge.ensureBootstrapRehydratedFromUpstash();
    expect(m.edge.getEdgeBootstrapAuthToken()).toBeNull();

    delete process.env.VERCEL;
    writeFileSync(join(dir, "kv.json"), "{not json");
    m = await freshModules();
    await m.edge.ensureBootstrapRehydratedFromUpstash();
    expect(m.edge.getEdgeBootstrapAuthToken()).toBeNull();
  });
});
