/**
 * Kebab House phase 2 (VLT-07): my_context / my_context_update in vault
 * mode read and write through the vault backend interface — here the KV
 * backend, with no GitHub credentials at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeMemoryKV } from "@/connectors/vault/lib/__tests__/memory-kv";

const kvRef = { current: makeMemoryKV() };
let contextPath = "Me/profile.md";

vi.mock("@/core/request-context", async () => {
  const actual =
    await vi.importActual<typeof import("@/core/request-context")>("@/core/request-context");
  return { ...actual, getContextKVStore: () => kvRef.current };
});

vi.mock("@/core/config", async () => {
  const actual = await vi.importActual<typeof import("@/core/config")>("@/core/config");
  return { ...actual, getInstanceConfigAsync: async () => ({ contextPath }) };
});

import { handleMyContext, handleMyContextUpdate } from "@/connectors/context/tools/my-context";
import { KV_CONTEXT_MODE } from "@/core/profiles";
import { kvVaultBackend } from "@/connectors/vault/lib/kv-backend";

function textOf(r: { content: Array<{ text?: string }> }): string {
  return r.content.map((c) => c.text ?? "").join("");
}

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  kvRef.current = makeMemoryKV();
  contextPath = "Me/profile.md";
  for (const k of ["GITHUB_PAT", "GITHUB_REPO", "KEBAB_VAULT_BACKEND"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  kvRef.current.store.set(KV_CONTEXT_MODE, "vault");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("my_context in vault mode on the KV backend", () => {
  it("reads the profile note from the KV vault", async () => {
    await kvVaultBackend.write("Me/profile.md", "# Me\nI build things.");
    expect(textOf(await handleMyContext())).toBe("# Me\nI build things.");
  });

  it("explains when the note does not exist yet", async () => {
    expect(textOf(await handleMyContext())).toMatch(/Profile file not found at "Me\/profile.md"/);
  });

  it("my_context_update creates, then appends to, the note in the KV vault", async () => {
    const created = await handleMyContextUpdate({ mode: "replace", content: "# Me" });
    expect(textOf(created)).toMatch(/in the vault \(replace\)/);
    await handleMyContextUpdate({ content: "Second line" });
    expect((await kvVaultBackend.read("Me/profile.md")).content).toBe("# Me\n\nSecond line");
    expect(textOf(await handleMyContext())).toBe("# Me\n\nSecond line");
    // Still in vault mode: the update did not switch the profile to inline.
    expect(kvRef.current.store.get(KV_CONTEXT_MODE)).toBe("vault");
    // The note shows up in the vault like any other.
    expect((await kvVaultBackend.recent(5))[0]).toMatchObject({
      path: "Me/profile.md",
      message: "Update profile (my_context_update)",
    });
  });

  it("refuses an update that would exceed the profile size limit", async () => {
    await kvVaultBackend.write("Me/profile.md", "x".repeat(64 * 1024 - 2));
    const r = await handleMyContextUpdate({ content: "yyyy" });
    expect(r.isError).toBe(true);
    expect((await kvVaultBackend.read("Me/profile.md")).content).toHaveLength(64 * 1024 - 2);
  });
});
