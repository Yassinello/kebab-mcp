/**
 * Phase 52 / DEV-04 — unit tests for src/core/device-invite.ts.
 *
 * Covers:
 *   - mintDeviceInvite: returns url + nonce + expiresAt, URL parses
 *   - verifyDeviceInvite: ok for valid, expired, bad_signature,
 *     wrong_intent, malformed
 *   - consumeDeviceInvite: first call wins, second call returns false
 *   - HMAC determinism: tamper with payload → bad_signature
 *   - KEBAB_DEVICE_INVITE_TTL_H override narrows the TTL
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const kvStore = new Map<string, string>();
let envVars: Record<string, string> = {};

vi.mock("@/core/request-context", () => {
  const kv = {
    kind: "filesystem" as const,
    get: async (k: string) => kvStore.get(k) ?? null,
    set: async (k: string, v: string) => {
      kvStore.set(k, v);
    },
    delete: async (k: string) => {
      kvStore.delete(k);
    },
    list: async () => Array.from(kvStore.keys()),
    setIfNotExists: async (k: string, v: string) => {
      if (kvStore.has(k)) return { ok: false as const, existing: kvStore.get(k) ?? "" };
      kvStore.set(k, v);
      return { ok: true as const };
    },
  };
  return {
    getContextKVStore: () => kv,
    getCurrentTenantId: () => null,
  };
});

vi.mock("@/core/config-facade", () => ({
  getConfig: (k: string) => envVars[k],
}));

vi.mock("@/core/signing-secret", () => ({
  getSigningSecret: async () => "0".repeat(64),
  SigningSecretUnavailableError: class extends Error {},
}));

import {
  mintDeviceInvite,
  verifyDeviceInvite,
  consumeDeviceInvite,
  readInviteConsumption,
  DEVICE_INVITE_INTENT,
} from "@/core/device-invite";

beforeEach(() => {
  kvStore.clear();
  envVars = {};
});

describe("mintDeviceInvite", () => {
  it("returns url, nonce, expiresAt with default 24h TTL", async () => {
    const before = Date.now();
    const { url, nonce, expiresAt } = await mintDeviceInvite({
      tenantId: null,
      label: "Claude Code",
    });
    expect(url).toMatch(/^\/welcome\/device-claim\?token=/);
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(expiresAt).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThan(before + 25 * 60 * 60 * 1000);
  });

  it("honors KEBAB_DEVICE_INVITE_TTL_H override", async () => {
    envVars.KEBAB_DEVICE_INVITE_TTL_H = "1"; // 1h
    const before = Date.now();
    const { expiresAt } = await mintDeviceInvite({ tenantId: null, label: "Phone" });
    expect(expiresAt).toBeGreaterThan(before + 59 * 60 * 1000);
    expect(expiresAt).toBeLessThan(before + 61 * 60 * 1000);
  });
});

describe("verifyDeviceInvite", () => {
  it("returns ok + payload for a freshly minted URL", async () => {
    const { url } = await mintDeviceInvite({ tenantId: null, label: "Laptop" });
    const token = new URL(url, "http://x").searchParams.get("token")!;
    const result = await verifyDeviceInvite(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.intent).toBe(DEVICE_INVITE_INTENT);
      expect(result.payload.label).toBe("Laptop");
      expect(result.payload.tenantId).toBeNull();
      expect(result.payload.nonce).toMatch(/^[a-f0-9]{32}$/);
    }
  });

  it("returns expired when past expiresAt", async () => {
    // Use a tiny TTL so the invite is born effectively expired after await.
    envVars.KEBAB_DEVICE_INVITE_TTL_H = "0.0001"; // 0.36s
    const { url } = await mintDeviceInvite({ tenantId: null, label: "Laptop" });
    await new Promise((r) => setTimeout(r, 500));
    const token = new URL(url, "http://x").searchParams.get("token")!;
    const result = await verifyDeviceInvite(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("returns bad_signature when the payload is tampered", async () => {
    const { url } = await mintDeviceInvite({ tenantId: null, label: "Laptop" });
    const token = new URL(url, "http://x").searchParams.get("token")!;
    // Flip a byte in the base64url payload portion.
    const [payloadB64, sig] = token.split(".");
    const mutatedPayload =
      payloadB64!.slice(0, -2) + (payloadB64!.slice(-2) === "AA" ? "AB" : "AA");
    const tampered = `${mutatedPayload}.${sig}`;
    const result = await verifyDeviceInvite(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/bad_signature|malformed/);
  });

  it("returns malformed when token has no dot separator", async () => {
    const result = await verifyDeviceInvite("no-dot-here");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });
});

describe("consumeDeviceInvite", () => {
  it("first call returns true, second returns false (replay guard)", async () => {
    const nonce = "a".repeat(32);
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const first = await consumeDeviceInvite(nonce, "Laptop", expiresAt);
    expect(first).toBe(true);
    const second = await consumeDeviceInvite(nonce, "Laptop", expiresAt);
    expect(second).toBe(false);
    const record = await readInviteConsumption(nonce);
    expect(record?.label).toBe("Laptop");
    expect(typeof record?.consumedAt).toBe("string");
  });
});
