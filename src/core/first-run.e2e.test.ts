/**
 * End-to-end integration tests for the welcome / first-run flow.
 *
 * These tests import the route handlers directly and call them with mock
 * Request objects. The goal is to prove the full claim → init → status
 * cycle works under both manual and auto-magic modes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __resetFirstRunForTests,
  __resetFirstRunForTestsAsync,
  isBootstrapActive,
  isFirstRunMode,
  clearBootstrap,
  rehydrateBootstrapFromTmp,
  __internals,
} from "./first-run";

import { POST as claimPost } from "../../app/api/welcome/claim/route";
import { POST as initPost } from "../../app/api/welcome/init/route";
import { GET as statusGet } from "../../app/api/welcome/status/route";

const ORIG_TOKEN = process.env.MCP_AUTH_TOKEN;
const ORIG_VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const ORIG_VERCEL_PROJECT = process.env.VERCEL_PROJECT_ID;
const ORIG_RECOVERY = process.env.MYMCP_RECOVERY_RESET;

function makeRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

function extractCookie(res: Response): string | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  // Take the value before the first ;.
  const m = setCookie.match(/^([^;]+)/);
  return m ? m[1] : null;
}

beforeEach(async () => {
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_PROJECT_ID;
  delete process.env.MYMCP_RECOVERY_RESET;
  await __resetFirstRunForTestsAsync();
});

afterEach(async () => {
  if (ORIG_TOKEN === undefined) delete process.env.MCP_AUTH_TOKEN;
  else process.env.MCP_AUTH_TOKEN = ORIG_TOKEN;
  if (ORIG_VERCEL_TOKEN === undefined) delete process.env.VERCEL_TOKEN;
  else process.env.VERCEL_TOKEN = ORIG_VERCEL_TOKEN;
  if (ORIG_VERCEL_PROJECT === undefined) delete process.env.VERCEL_PROJECT_ID;
  else process.env.VERCEL_PROJECT_ID = ORIG_VERCEL_PROJECT;
  if (ORIG_RECOVERY === undefined) delete process.env.MYMCP_RECOVERY_RESET;
  else process.env.MYMCP_RECOVERY_RESET = ORIG_RECOVERY;
  await __resetFirstRunForTestsAsync();
  vi.restoreAllMocks();
});

describe("e2e: happy path manual flow", () => {
  it("walks claim → init → status with no Vercel auto-magic", async () => {
    // Step 1: claim
    const claimRes = await claimPost(
      makeRequest("http://localhost/api/welcome/claim", { method: "POST" })
    );
    expect(claimRes.status).toBe(200);
    const claimBody = (await claimRes.json()) as { status: string; isNew: boolean };
    expect(claimBody.status).toBe("new");
    expect(claimBody.isNew).toBe(true);

    const cookie = extractCookie(claimRes);
    expect(cookie).toBeTruthy();

    // Step 2: init with the cookie
    const initRes = await initPost(
      makeRequest("http://localhost/api/welcome/init", {
        method: "POST",
        headers: { cookie: cookie! },
      })
    );
    expect(initRes.status).toBe(200);
    const initBody = (await initRes.json()) as {
      ok: boolean;
      token: string;
      instanceUrl: string;
      autoMagic: boolean;
    };
    expect(initBody.ok).toBe(true);
    expect(initBody.token).toMatch(/^[0-9a-f]{64}$/);
    expect(initBody.instanceUrl).toMatch(/^https?:\/\//);
    expect(initBody.autoMagic).toBe(false);
    // SEC-02: token is in the in-memory bootstrap cache, not process.env.
    const { getBootstrapAuthToken } = await import("./first-run");
    expect(getBootstrapAuthToken()).toBe(initBody.token);
    expect(process.env.MCP_AUTH_TOKEN).toBeUndefined();

    // Step 3: status — bootstrap active
    const statusRes = await statusGet(makeRequest("http://localhost/api/welcome/status"));
    const statusBody = (await statusRes.json()) as {
      initialized: boolean;
      permanent: boolean;
      isBootstrap: boolean;
    };
    expect(statusBody.initialized).toBe(true);
    expect(statusBody.permanent).toBe(false);
    expect(statusBody.isBootstrap).toBe(true);

    // Step 4: simulate Vercel redeploy with the token now persisted "for real".
    clearBootstrap();
    process.env.MCP_AUTH_TOKEN = "x".repeat(32);

    const statusRes2 = await statusGet(makeRequest("http://localhost/api/welcome/status"));
    const statusBody2 = (await statusRes2.json()) as {
      initialized: boolean;
      permanent: boolean;
      isBootstrap: boolean;
    };
    expect(statusBody2.initialized).toBe(true);
    expect(statusBody2.permanent).toBe(true);
    expect(statusBody2.isBootstrap).toBe(false);
  });
});

describe("e2e: locked-out second visitor", () => {
  it("rejects a second claim attempt with 423", async () => {
    // Visitor 1
    const r1 = await claimPost(
      makeRequest("http://localhost/api/welcome/claim", { method: "POST" })
    );
    expect(r1.status).toBe(200);

    // Visitor 2 — no cookie
    const r2 = await claimPost(
      makeRequest("http://localhost/api/welcome/claim", { method: "POST" })
    );
    expect(r2.status).toBe(423);
    const body = (await r2.json()) as { status: string };
    expect(body.status).toBe("claimed-by-other");
  });
});

describe("e2e: forged cookie rejected", () => {
  it("returns 403 when init is called with an unsigned cookie", async () => {
    // Populate state with a real claim first.
    await claimPost(makeRequest("http://localhost/api/welcome/claim", { method: "POST" }));

    const initRes = await initPost(
      makeRequest("http://localhost/api/welcome/init", {
        method: "POST",
        headers: { cookie: "mymcp_firstrun_claim=garbage.notavalidsignature" },
      })
    );
    expect(initRes.status).toBe(403);
  });
});

describe("e2e: MCP endpoint guard in first-run", () => {
  // 30s timeout: the dynamic import of [transport]/route pulls in mcp-handler
  // and the entire connector registry, which can be slow on cold compile.
  it("returns 503 with a 'Visit /welcome' message when MCP_AUTH_TOKEN is unset", async () => {
    delete process.env.MCP_AUTH_TOKEN;
    expect(isFirstRunMode()).toBe(true);

    // Import lazily to avoid mcp-handler init at module load time.
    const transport = await import("../../app/api/[transport]/route");
    const handler = transport.GET as (req: Request) => Promise<Response>;

    const res = await handler(makeRequest("http://localhost/api/mcp", { method: "GET" }));
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("Visit /welcome");
  }, 30_000);
});

describe("e2e: recovery reset", () => {
  it("MYMCP_RECOVERY_RESET=1 wipes bootstrap state on rehydrate", async () => {
    // Mint a bootstrap.
    const claimRes = await claimPost(
      makeRequest("http://localhost/api/welcome/claim", { method: "POST" })
    );
    const cookie = extractCookie(claimRes)!;
    await initPost(
      makeRequest("http://localhost/api/welcome/init", {
        method: "POST",
        headers: { cookie },
      })
    );
    expect(isBootstrapActive()).toBe(true);

    // Trip the recovery flag and rehydrate.
    process.env.MYMCP_RECOVERY_RESET = "1";
    rehydrateBootstrapFromTmp();

    // In-memory bootstrap is cleared. Note: process.env.MCP_AUTH_TOKEN was
    // mutated by bootstrapToken() and forceReset() does NOT unset it (it
    // can't safely — that's an instance-level concern). We assert against
    // the actual behavior.
    expect(isBootstrapActive()).toBe(false);
    // Tmp file deleted.
    const fs = await import("node:fs");
    expect(fs.existsSync(__internals.BOOTSTRAP_PATH)).toBe(false);
  });
});

describe("e2e: auto-magic happy path with mocked Vercel API", () => {
  it("writes env + triggers redeploy when Vercel creds are set", async () => {
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "test-project";

    // Reset the env-store factory cache so it picks up Vercel mode.
    // We can't import the private cache, so instead we rely on the fact
    // that VERCEL is not set to "1" in test → the factory picks Filesystem.
    // For this test, we directly mock the env-store module's getEnvStore
    // to return a stub with a write() that resolves successfully.
    const envStoreModule = await import("./env-store");
    const writeMock = vi.fn(async () => ({ written: 1, note: "ok" }));
    vi.spyOn(envStoreModule, "getEnvStore").mockReturnValue({
      kind: "vercel",
      read: async () => ({}),
      write: writeMock,
      // NIT-09: EnvStore.delete is required by the interface as of v0.6.
      delete: async () => ({ deleted: false }),
    });

    // Mock fetch for the Vercel deployments REST calls.
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/v6/deployments")) {
        return new Response(
          JSON.stringify({
            deployments: [
              {
                uid: "dpl_old",
                name: "my-mcp",
                meta: { githubCommitRef: "main" },
                gitSource: { type: "github", repoId: 12345, ref: "main" },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes("/v13/deployments")) {
        return new Response(JSON.stringify({ id: "dpl_xyz" }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    const origFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const claimRes = await claimPost(
        makeRequest("http://localhost/api/welcome/claim", { method: "POST" })
      );
      const cookie = extractCookie(claimRes)!;

      const initRes = await initPost(
        makeRequest("http://localhost/api/welcome/init", {
          method: "POST",
          headers: { cookie },
        })
      );
      expect(initRes.status).toBe(200);
      const body = (await initRes.json()) as {
        ok: boolean;
        autoMagic: boolean;
        envWritten: boolean;
        redeployTriggered: boolean;
      };
      expect(body.ok).toBe(true);
      expect(body.autoMagic).toBe(true);
      expect(body.envWritten).toBe(true);
      expect(body.redeployTriggered).toBe(true);
      expect(writeMock).toHaveBeenCalledWith(
        expect.objectContaining({ MCP_AUTH_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/) })
      );
    } finally {
      global.fetch = origFetch;
    }
  });
});
