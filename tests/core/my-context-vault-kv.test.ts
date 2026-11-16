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

import {
  handleMyContext,
  handleMyContextUpdate,
  readActiveProfile,
} from "@/connectors/context/tools/my-context";
import { handleKebabSetup } from "@/connectors/context/tools/setup";
import { handleKebabStatus } from "@/connectors/house/tools/house-tools";
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

describe("readActiveProfile — one resolver for my_context, kebab_setup, kebab_status", () => {
  it("returns the vault note in vault mode, and flags a missing note", async () => {
    expect(await readActiveProfile()).toEqual({
      name: "default",
      mode: "vault",
      content: "",
      path: "Me/profile.md",
      missing: true,
    });
    await kvVaultBackend.write("Me/profile.md", "# Me\nI build things.");
    expect(await readActiveProfile()).toMatchObject({
      mode: "vault",
      content: "# Me\nI build things.",
    });
  });

  it("kebab_setup sees a vault-mode profile instead of reporting it missing", async () => {
    await kvVaultBackend.write("Me/profile.md", "# Me\nI build things.");
    await handleKebabSetup({ action: "goto", step: "profile" });
    const text = textOf(await handleKebabSetup({}));
    expect(text).toMatch(/A profile already exists \(stored as the note "Me\/profile.md"/);
    expect(text).not.toMatch(/No profile exists yet/);
  });

  it("kebab_status previews the vault-mode profile", async () => {
    await kvVaultBackend.write("Me/profile.md", "# Me\nI build things.");
    const status = await handleKebabStatus();
    expect(textOf(status)).toContain("Profile: **default**");
    expect(textOf(status)).not.toContain("(empty");
    expect(status.structuredContent).toMatchObject({
      profile: { preview: "# Me\nI build things." },
    });
  });
});
