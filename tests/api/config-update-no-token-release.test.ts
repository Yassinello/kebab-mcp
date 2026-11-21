/**
 * GET /api/config/update without a token (UPD-10, UPD-12,
 * docs/specs/cdc-instances-testeurs.md): the answer keeps its no-token
 * shape and adds the latest upstream release, read anonymously and cached
 * in KV (`global:upstream-release`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/core/config-facade", () => ({ getConfig: vi.fn() }));
vi.mock("@/core/request-context", () => ({
  getCredential: vi.fn(),
  runWithCredentials: vi.fn((creds: Record<string, string>, fn: () => unknown) => fn()),
  requestContext: { getStore: vi.fn(() => undefined) },
}));
vi.mock("@/core/pipeline", async () => {
  const actual = await vi.importActual<typeof import("@/core/pipeline")>("@/core/pipeline");
  return { ...actual, composeRequestPipeline: <H>(_steps: unknown[], handler: H) => handler };
});
vi.mock("@/core/with-bootstrap-rehydrate", () => ({
  withBootstrapRehydrate: (fn: unknown) => fn,
}));

const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock("@/core/kv-store", () => ({
  getKVStore: () => ({ kind: "filesystem" as const, get: kvGet, set: kvSet, delete: vi.fn() }),
}));

import { getConfig } from "@/core/config-facade";
import { getCredential } from "@/core/request-context";
import { VERSION } from "@/core/version";
import { UPSTREAM_RELEASE_KV_KEY, UPSTREAM_RELEASE_TTL_SECONDS } from "@/core/upstream-release";

const mockGetConfig = vi.mocked(getConfig);
const mockGetCredential = vi.mocked(getCredential);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A version strictly above the build's, whatever package.json says. */
const NEXT = VERSION.replace(/(\d+)$/, (n) => String(Number(n) + 1));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  kvGet.mockReset().mockResolvedValue(null);
  kvSet.mockReset().mockResolvedValue(undefined);
  mockGetConfig
    .mockReset()
    .mockImplementation(
      (key: string) =>
        ({ VERCEL: "1", VERCEL_GIT_REPO_OWNER: "me", VERCEL_GIT_REPO_SLUG: "kebab-house" })[
          key
        ] as string
    );
  mockGetCredential.mockReset().mockReturnValue(undefined);
  vi.stubEnv("KEBAB_UPDATE_PAT", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function get(url = "http://localhost/api/config/update") {
  const mod = await import("../../app/api/config/update/route");
  const res = await (mod.GET as unknown as (c: unknown) => Promise<Response>)({
    request: new Request(url),
  });
  return (await res.json()) as Record<string, unknown>;
}

describe("GET /api/config/update — no token, newer release upstream", () => {
  it("keeps the no-token shape and announces the release", async () => {
    fetchMock.mockResolvedValueOnce(json({ tag_name: `v${NEXT}` }));
    const body = await get();
    expect(body).toMatchObject({
      mode: "github-api",
      reason: "no-token",
      tokenConfigured: false,
      configureUrl: "/config?tab=settings&sub=advanced",
      available: true,
      installedVersion: VERSION,
      latestVersion: NEXT,
      releaseUrl: `https://github.com/Yassinello/kebab-mcp/releases/tag/v${NEXT}`,
    });
    // Anonymous read of upstream only — never the user's repo.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/repos/Yassinello/kebab-mcp/");
    // Cached for the next page loads.
    expect(kvSet).toHaveBeenCalledWith(
      UPSTREAM_RELEASE_KV_KEY,
      expect.stringContaining(`"version":"${NEXT}"`),
      UPSTREAM_RELEASE_TTL_SECONDS
    );
  });

  it("serves the KV cache without calling GitHub", async () => {
    kvGet.mockResolvedValueOnce(
      JSON.stringify({
        version: NEXT,
        tag: `v${NEXT}`,
        url: "https://cached",
        source: "api",
        checkedAt: new Date().toISOString(),
      })
    );
    const body = await get();
    expect(body.available).toBe(true);
    expect(body.releaseUrl).toBe("https://cached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("?force=1 skips the cache", async () => {
    kvGet.mockResolvedValue(
      JSON.stringify({ version: NEXT, url: "https://cached", checkedAt: "2026-01-01T00:00:00Z" })
    );
    fetchMock.mockResolvedValueOnce(json({ tag_name: `v${VERSION}` }));
    const body = await get("http://localhost/api/config/update?force=1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.available).toBe(false);
    expect(body.latestVersion).toBe(VERSION);
  });
});

describe("GET /api/config/update — no token, GitHub unreachable", () => {
  it("answers the plain no-token shape and caches nothing", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const body = await get();
    expect(body).toMatchObject({ reason: "no-token", available: false, tokenConfigured: false });
    expect(body.latestVersion).toBeUndefined();
    expect(kvSet).not.toHaveBeenCalled();
  });

  it("survives a KV outage", async () => {
    kvGet.mockRejectedValue(new Error("upstash down"));
    kvSet.mockRejectedValue(new Error("upstash down"));
    fetchMock.mockResolvedValueOnce(json({ tag_name: `v${NEXT}` }));
    const body = await get();
    expect(body.available).toBe(true);
  });
});
