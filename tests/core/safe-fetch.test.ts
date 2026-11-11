/**
 * SEC-08 / SEC-09 (2026-11 audit) — safeFetch redirect handling and the API
 * connector's interpolation hardening.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Deterministic SSRF guard: only the sync classifier, no real DNS.
vi.mock("@/core/url-safety", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/url-safety")>();
  return {
    ...actual,
    isPublicUrl: async (url: string, opts: Parameters<typeof actual.isPublicUrlSync>[1]) =>
      actual.isPublicUrlSync(url, opts),
  };
});

import { safeFetch, SafeFetchError } from "@/core/safe-fetch";
import { interpolatePath, interpolateJsonBody } from "@/connectors/api/lib/invoke";

type Hop = { url: string; method: string; headers: Record<string, string>; body: unknown };

describe("safeFetch", () => {
  const hops: Hop[] = [];
  let routes: Record<string, () => Response>;

  beforeEach(() => {
    hops.length = 0;
    routes = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((v, k) => (headers[k] = v));
        hops.push({ url, method: init.method ?? "GET", headers, body: init.body });
        expect(init.redirect).toBe("manual");
        const route = routes[url];
        return route ? route() : new Response("ok", { status: 200 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("EXPLOIT: refuses a 302 from a public host to the cloud metadata endpoint", async () => {
    routes["https://api.example.com/data"] = () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    await expect(safeFetch("https://api.example.com/data")).rejects.toThrow(
      /Redirect target rejected/
    );
    expect(hops).toHaveLength(1);
  });

  it("EXPLOIT: refuses a redirect to an RFC1918 address", async () => {
    routes["https://api.example.com/a"] = () =>
      new Response(null, { status: 301, headers: { location: "http://10.0.0.5/admin" } });
    await expect(safeFetch("https://api.example.com/a")).rejects.toBeInstanceOf(SafeFetchError);
  });

  it("EXPLOIT: drops credentials (incl. custom API-key header) on a cross-origin redirect", async () => {
    routes["https://api.example.com/a"] = () =>
      new Response(null, { status: 302, headers: { location: "https://other.example.net/b" } });
    await safeFetch(
      "https://api.example.com/a",
      { headers: { Authorization: "Bearer T", "X-Api-Key": "K", Accept: "application/json" } },
      { sensitiveHeaders: ["X-Api-Key"] }
    );
    expect(hops).toHaveLength(2);
    expect(hops[0]?.headers["authorization"]).toBe("Bearer T");
    expect(hops[1]?.headers["authorization"]).toBeUndefined();
    expect(hops[1]?.headers["x-api-key"]).toBeUndefined();
    expect(hops[1]?.headers["accept"]).toBe("application/json");
  });

  it("keeps credentials on a same-origin redirect", async () => {
    routes["https://api.example.com/a"] = () =>
      new Response(null, { status: 307, headers: { location: "/b" } });
    await safeFetch("https://api.example.com/a", { headers: { Authorization: "Bearer T" } });
    expect(hops[1]?.url).toBe("https://api.example.com/b");
    expect(hops[1]?.headers["authorization"]).toBe("Bearer T");
  });

  it("downgrades POST to GET without body on 303", async () => {
    routes["https://api.example.com/a"] = () =>
      new Response(null, { status: 303, headers: { location: "/done" } });
    await safeFetch("https://api.example.com/a", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect(hops[1]?.method).toBe("GET");
    expect(hops[1]?.body).toBeUndefined();
  });

  it("caps the number of redirects", async () => {
    routes["https://api.example.com/loop"] = () =>
      new Response(null, { status: 302, headers: { location: "/loop" } });
    await expect(
      safeFetch("https://api.example.com/loop", {}, { maxRedirects: 3 })
    ).rejects.toThrow(/Too many redirects/);
  });
});

describe("API connector interpolation — SEC-09", () => {
  it("percent-encodes path values but keeps slashes", () => {
    expect(interpolatePath("/users/{{id}}", { id: "a b?x=1#f" })).toBe("/users/a%20b%3Fx%3D1%23f");
    expect(interpolatePath("/repos/{{slug}}", { slug: "owner/name" })).toBe("/repos/owner/name");
  });

  it("EXPLOIT: refuses dot segments in path arguments", () => {
    expect(() => interpolatePath("/users/{{id}}", { id: "../admin/users" })).toThrow(
      /dot segments/
    );
    expect(() => interpolatePath("/users/{{id}}", { id: ".." })).toThrow();
  });

  it("EXPLOIT: a string value cannot inject JSON keys", () => {
    const body = interpolateJsonBody('{"name":"{{name}}"}', { name: 'x","role":"admin' });
    expect(JSON.parse(body)).toEqual({ name: 'x","role":"admin' });
  });

  it("bare positions accept JSON scalars and quote everything else", () => {
    const body = interpolateJsonBody('{"n": {{n}}, "flag": {{f}}, "s": {{s}}}', {
      n: "42",
      f: true,
      s: '1, "role": "admin"',
    });
    expect(JSON.parse(body)).toEqual({ n: 42, flag: true, s: '1, "role": "admin"' });
  });

  it("REVIEW: placeholders inside longer strings stay valid JSON", () => {
    const body = interpolateJsonBody('{"text": "Hello {{name}}! \\"q\\" {{x}}", "n": {{n}}}', {
      name: 'Bob "the" builder',
      x: "a\\b",
      n: 3,
    });
    expect(JSON.parse(body)).toEqual({ text: 'Hello Bob "the" builder! "q" a\\b', n: 3 });
  });

  it("a bare placeholder given a JSON object string keeps it as one JSON value", () => {
    const body = interpolateJsonBody('{"payload": {{obj}}}', { obj: '{"a":1}' });
    expect(JSON.parse(body)).toEqual({ payload: { a: 1 } });
    const evil = interpolateJsonBody('{"payload": {{obj}}}', { obj: '{"a":1}, "role": "admin"' });
    expect(JSON.parse(evil)).toEqual({ payload: '{"a":1}, "role": "admin"' });
  });

  it("missing values become null in bare positions and empty in strings", () => {
    const body = interpolateJsonBody('{"a": {{a}}, "b": "{{b}}"}', {});
    expect(JSON.parse(body)).toEqual({ a: null, b: "" });
  });
});
