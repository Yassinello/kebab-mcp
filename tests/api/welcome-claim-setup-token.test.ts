/**
 * SEC-07 (2026-11 audit) — optional deploy-time setup token for
 * /api/welcome/claim. When KEBAB_SETUP_TOKEN is set, a new claim requires
 * it; without it the historical "first visitor wins" behaviour remains.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as kvStore from "@/core/kv-store";
import { __resetFirstRunForTests } from "@/core/first-run";
import { resetSigningSecretCache } from "@/core/signing-secret";

function makeStubKv() {
  const store = new Map<string, string>();
  return {
    kind: "filesystem" as const,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    list: vi.fn(async () => Array.from(store.keys())),
    setIfNotExists: vi.fn(async (k: string, v: string) => {
      const existing = store.get(k);
      if (existing !== undefined) return { ok: false as const, existing };
      store.set(k, v);
      return { ok: true as const };
    }),
  };
}

describe("/api/welcome/claim — KEBAB_SETUP_TOKEN", () => {
  let kvSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("MCP_AUTH_TOKEN", "");
    vi.stubEnv("MYMCP_ALLOW_EPHEMERAL_SECRET", "1");
    vi.stubEnv("VERCEL", "");
    kvSpy = vi
      .spyOn(kvStore, "getKVStore")
      .mockReturnValue(makeStubKv() as unknown as ReturnType<typeof kvStore.getKVStore>);
    __resetFirstRunForTests();
    resetSigningSecretCache();
  });

  afterEach(() => {
    kvSpy.mockRestore();
    vi.unstubAllEnvs();
    __resetFirstRunForTests();
  });

  async function claim(headers: Record<string, string> = {}, query = "") {
    const { POST } = await import("../../app/api/welcome/claim/route");
    return POST(
      new Request(`http://localhost/api/welcome/claim${query}`, {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.7", ...headers },
      })
    );
  }

  it("without KEBAB_SETUP_TOKEN the first visitor can claim (unchanged behaviour)", async () => {
    const res = await claim();
    expect(res.status).toBe(200);
  });

  it("refuses a claim without the setup token", async () => {
    vi.stubEnv("KEBAB_SETUP_TOKEN", "s3tup-t0ken-value");
    const res = await claim();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("setup-token-required");
  });

  it("refuses a wrong setup token", async () => {
    vi.stubEnv("KEBAB_SETUP_TOKEN", "s3tup-t0ken-value");
    const res = await claim({ "x-kebab-setup-token": "nope" });
    expect(res.status).toBe(401);
  });

  it("accepts the setup token via header or ?setup= query", async () => {
    vi.stubEnv("KEBAB_SETUP_TOKEN", "s3tup-t0ken-value");
    const res = await claim({ "x-kebab-setup-token": "s3tup-t0ken-value" });
    expect(res.status).toBe(200);
    __resetFirstRunForTests();
    kvSpy.mockReturnValue(makeStubKv() as unknown as ReturnType<typeof kvStore.getKVStore>);
    const res2 = await claim({}, "?setup=s3tup-t0ken-value");
    expect(res2.status).toBe(200);
  });
});
