/**
 * Tests for src/core/upstash-env.ts — DUR-06.
 *
 * Behaviors:
 *   1. Empty env → null.
 *   2. UPSTASH_* both set → returns with source "upstash-redis".
 *   3. KV_* both set (no UPSTASH_*) → returns with source "vercel-marketplace".
 *   4. Both variants set → UPSTASH_* wins (explicit over marketplace default).
 *   5. Partial UPSTASH_* (url only, or token only) → null.
 *   6. Partial KV_* → null.
 *   7. Whitespace is trimmed.
 *   8. `hasUpstashCreds()` mirrors `getUpstashCreds() !== null`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getUpstashCreds, hasUpstashCreds } from "@/core/upstash-env";

const SAVED: Record<string, string | undefined> = {};
const KEYS = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
];

function clearAll(): void {
  for (const k of KEYS) delete process.env[k];
}

describe("upstash-env (DUR-06)", () => {
  beforeEach(() => {
    for (const k of KEYS) SAVED[k] = process.env[k];
    clearAll();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
  });

  it("returns null with no creds set", () => {
    expect(getUpstashCreds()).toBeNull();
    expect(hasUpstashCreds()).toBe(false);
  });

  it("returns upstash-redis source when UPSTASH_* set", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://u.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "u-tok";
    expect(getUpstashCreds()).toEqual({
      url: "https://u.upstash.io",
      token: "u-tok",
      source: "upstash-redis",
    });
    expect(hasUpstashCreds()).toBe(true);
  });

  it("returns vercel-marketplace source when only KV_* set", () => {
    process.env.KV_REST_API_URL = "https://k.kv.io";
    process.env.KV_REST_API_TOKEN = "k-tok";
    expect(getUpstashCreds()).toEqual({
      url: "https://k.kv.io",
      token: "k-tok",
      source: "vercel-marketplace",
    });
  });

  it("prefers UPSTASH_* when both are set", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://u.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "u-tok";
    process.env.KV_REST_API_URL = "https://k.kv.io";
    process.env.KV_REST_API_TOKEN = "k-tok";
    expect(getUpstashCreds()).toEqual({
      url: "https://u.upstash.io",
      token: "u-tok",
      source: "upstash-redis",
    });
  });

  it("returns null for partial UPSTASH_* (url only)", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://u.upstash.io";
    expect(getUpstashCreds()).toBeNull();
  });

  it("returns null for partial UPSTASH_* (token only)", () => {
    process.env.UPSTASH_REDIS_REST_TOKEN = "u-tok";
    expect(getUpstashCreds()).toBeNull();
  });

  it("returns null for partial KV_* (token only)", () => {
    process.env.KV_REST_API_TOKEN = "k-tok";
    expect(getUpstashCreds()).toBeNull();
  });

  it("falls back to KV_* when UPSTASH_* is incomplete", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://u.upstash.io"; // no token
    process.env.KV_REST_API_URL = "https://k.kv.io";
    process.env.KV_REST_API_TOKEN = "k-tok";
    // UPSTASH_* is incomplete → falls through to KV_*.
    expect(getUpstashCreds()).toEqual({
      url: "https://k.kv.io",
      token: "k-tok",
      source: "vercel-marketplace",
    });
  });

  it("trims whitespace from all values", () => {
    process.env.UPSTASH_REDIS_REST_URL = "   https://u.upstash.io\n";
    process.env.UPSTASH_REDIS_REST_TOKEN = "  u-tok  ";
    expect(getUpstashCreds()).toEqual({
      url: "https://u.upstash.io",
      token: "u-tok",
      source: "upstash-redis",
    });
  });

  it("hasUpstashCreds() mirrors getUpstashCreds() !== null", () => {
    expect(hasUpstashCreds()).toBe(false);
    process.env.KV_REST_API_URL = "https://k.kv.io";
    process.env.KV_REST_API_TOKEN = "k-tok";
    expect(hasUpstashCreds()).toBe(true);
    delete process.env.KV_REST_API_TOKEN;
    expect(hasUpstashCreds()).toBe(false);
  });
});
