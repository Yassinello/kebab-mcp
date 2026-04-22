/**
 * Phase 50 / COV-04 — Apify client backfill.
 *
 * Exercises runActor + apifyGet with happy + error paths; asserts the
 * APIFY_TOKEN value is stripped from error messages (sanitize()).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("@/core/fetch-utils", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchMock(...args),
}));

async function loadModule() {
  return await import("../client");
}

describe("Phase 50 / COV-04 — apify/lib/client.ts", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env.APIFY_TOKEN = "secret-apify-token";
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.APIFY_TOKEN;
  });

  describe("runActor", () => {
    it("happy path — returns array of dataset items", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify([{ a: 1 }, { a: 2 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const { runActor } = await loadModule();
      const items = await runActor("owner/actor", { url: "https://x" });
      expect(items).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Verify URL substitutes `/` with `~`
      const call = fetchMock.mock.calls[0]!;
      expect(String(call[0])).toContain("owner~actor");
    });

    it("non-array JSON → wrapped in array", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ single: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      const { runActor } = await loadModule();
      const items = await runActor("actor", {});
      expect(items).toEqual([{ single: true }]);
    });

    it("null JSON → empty array", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("null", { status: 200, headers: { "Content-Type": "application/json" } })
      );
      const { runActor } = await loadModule();
      const items = await runActor("actor", {});
      expect(items).toEqual([]);
    });

    it("408 → explicit timeout message", async () => {
      fetchMock.mockResolvedValueOnce(new Response("timeout", { status: 408 }));
      const { runActor } = await loadModule();
      await expect(runActor("slow", {})).rejects.toThrow(/did not complete within/);
    });

    it("504 → explicit timeout message", async () => {
      fetchMock.mockResolvedValueOnce(new Response("gateway timeout", { status: 504 }));
      const { runActor } = await loadModule();
      await expect(runActor("slow", {})).rejects.toThrow(/did not complete within/);
    });

    it("400 → surfaces status + body (token redacted)", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("bad input secret-apify-token", { status: 400 })
      );
      const { runActor } = await loadModule();
      try {
        await runActor("actor", {});
        expect.fail("should throw");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toMatch(/400/);
        expect(msg).not.toContain("secret-apify-token");
        expect(msg).toContain("<redacted>");
      }
    });

    it("fetch throws (AbortError class) → wrapped with sanitize", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNABORTED on secret-apify-token"));
      const { runActor } = await loadModule();
      await expect(runActor("actor", {})).rejects.toThrow(/Apify fetch failed/);
    });
  });

  describe("apifyGet", () => {
    it("happy path — returns typed JSON", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { items: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      const { apifyGet } = await loadModule();
      const result = await apifyGet<{ data: { items: unknown[] } }>("/acts");
      expect(result.data.items).toEqual([]);
    });
  });

  it("missing APIFY_TOKEN → throws clear error", async () => {
    delete process.env.APIFY_TOKEN;
    vi.resetModules();
    const { runActor } = await loadModule();
    await expect(runActor("actor", {})).rejects.toThrow(/APIFY_TOKEN/);
  });
});
