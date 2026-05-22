/**
 * Phase 73 (v0.18) — multi-account connector credential store + resolver.
 *
 * Coverage:
 *  MACS-01  save → list round-trips two distinct Slack accounts with
 *           distinct bot tokens.
 *  MACS-02  legacy flat SLACK_BOT_TOKEN (no index) → ONE "default"
 *           account; resolve with no args returns it silently. Notion
 *           single-key legacy round-trip too.
 *  MACS-03  resolver precedence: explicit valid wins; explicit miss →
 *           error_account_required + names; 0 → error_no_account; 1 →
 *           silent; ≥2 no default → error_account_required + names.
 *  MACS-04  pinned default honored; stale pin (default → removed
 *           account) falls through to count rules.
 *  MACS-05  tenant isolation: write under tenant A, read under tenant B
 *           returns nothing.
 *  + removeAccount clears a default that pointed at it.
 *  + Notion single-key account round-trip (explicit store path).
 *
 * Mocks: getContextKVStore + getCredential mocked via the canonical
 * vi.hoisted pattern (matches credential-store + unipile account tests).
 * The KV mock is a tenant-aware Map-backed fake: getContextKVStore reads
 * the ambient `currentTenant` and prefixes keys, so the SAME backing
 * store proves cross-tenant isolation (a tenant-A key is invisible under
 * tenant B because the prefixes differ).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const backing = new Map<string, string>();
  // Ambient tenant for the next getContextKVStore() call. The resolver
  // and store helpers call getContextKVStore() synchronously per op, so
  // flipping this between operations simulates separate request scopes.
  let currentTenant: string | null = null;
  // Per-key credential overrides for the legacy-fallback (getCredential).
  const creds = new Map<string, string>();

  function pk(key: string): string {
    return currentTenant ? `tenant:${currentTenant}:${key}` : key;
  }

  const kv = {
    kind: "filesystem" as const,
    get: vi.fn(async (k: string) => backing.get(pk(k)) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      backing.set(pk(k), v);
    }),
    delete: vi.fn(async (k: string) => {
      backing.delete(pk(k));
    }),
    list: vi.fn(async (prefix?: string) =>
      Array.from(backing.keys()).filter((k) => (prefix ? k.startsWith(pk(prefix)) : true))
    ),
  };

  return {
    backing,
    creds,
    kv,
    setTenant: (t: string | null) => {
      currentTenant = t;
    },
    getCredentialMock: vi.fn((key: string) => creds.get(key)),
  };
});

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => hoist.kv,
  getCredential: hoist.getCredentialMock,
}));

import {
  listAccounts,
  saveAccount,
  removeAccount,
  setDefaultAccount,
  getDefaultAccount,
  resolveConnectorAccount,
  slugify,
} from "../connector-accounts";

beforeEach(() => {
  hoist.backing.clear();
  hoist.creds.clear();
  hoist.setTenant(null);
  hoist.kv.get.mockClear();
  hoist.kv.set.mockClear();
  hoist.kv.delete.mockClear();
  hoist.getCredentialMock.mockClear();
});

describe("slugify", () => {
  it("lowercases, kebabs, strips accents and punctuation", () => {
    expect(slugify("Acme Corp")).toBe("acme-corp");
    expect(slugify("  Héllo,  World!  ")).toBe("hello-world");
    expect(slugify("ACME")).toBe("acme");
  });

  it("falls back to 'account' when no usable characters remain", () => {
    expect(slugify("🎉")).toBe("account");
    expect(slugify("   ")).toBe("account");
  });
});

describe("saveAccount + listAccounts (MACS-01)", () => {
  it("round-trips two distinct Slack accounts with distinct bot tokens", async () => {
    await saveAccount("slack", "Acme Workspace", { SLACK_BOT_TOKEN: "xoxb-acme" });
    await saveAccount("slack", "Beta Workspace", {
      SLACK_BOT_TOKEN: "xoxb-beta",
      SLACK_USER_TOKEN: "xoxp-beta",
    });

    const accounts = await listAccounts("slack");
    expect(accounts).toHaveLength(2);

    const acme = accounts.find((a) => a.slug === "acme-workspace");
    const beta = accounts.find((a) => a.slug === "beta-workspace");
    expect(acme).toEqual({
      slug: "acme-workspace",
      name: "Acme Workspace",
      tokens: { SLACK_BOT_TOKEN: "xoxb-acme" },
    });
    expect(beta).toEqual({
      slug: "beta-workspace",
      name: "Beta Workspace",
      tokens: { SLACK_BOT_TOKEN: "xoxb-beta", SLACK_USER_TOKEN: "xoxp-beta" },
    });
  });

  it("dedupes slugs when two accounts share a display name", async () => {
    await saveAccount("slack", "Acme", { SLACK_BOT_TOKEN: "xoxb-1" });
    // Distinct save path: same name re-saves in place (no dup), so use a
    // name that slugifies identically but isn't string-equal.
    await saveAccount("slack", "ACME", { SLACK_BOT_TOKEN: "xoxb-2" });
    const accounts = await listAccounts("slack");
    const slugs = accounts.map((a) => a.slug).sort();
    expect(slugs).toEqual(["acme", "acme-2"]);
  });

  it("re-saving under the same display name overwrites tokens in place", async () => {
    await saveAccount("slack", "Acme", { SLACK_BOT_TOKEN: "xoxb-old" });
    await saveAccount("slack", "Acme", { SLACK_BOT_TOKEN: "xoxb-new" });
    const accounts = await listAccounts("slack");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.tokens).toEqual({ SLACK_BOT_TOKEN: "xoxb-new" });
  });

  it("Notion single-key account round-trips", async () => {
    await saveAccount("notion", "My Notion", { NOTION_API_KEY: "ntn_secret" });
    const accounts = await listAccounts("notion");
    expect(accounts).toEqual([
      { slug: "my-notion", name: "My Notion", tokens: { NOTION_API_KEY: "ntn_secret" } },
    ]);
  });
});

describe("legacy flat-key fallback (MACS-02)", () => {
  it("synthesizes ONE 'default' Slack account from SLACK_BOT_TOKEN with no index", async () => {
    hoist.creds.set("SLACK_BOT_TOKEN", "xoxb-legacy");
    const accounts = await listAccounts("slack");
    expect(accounts).toEqual([
      { slug: "default", name: "default", tokens: { SLACK_BOT_TOKEN: "xoxb-legacy" } },
    ]);
  });

  it("includes the optional SLACK_USER_TOKEN in the legacy default when present", async () => {
    hoist.creds.set("SLACK_BOT_TOKEN", "xoxb-legacy");
    hoist.creds.set("SLACK_USER_TOKEN", "xoxp-legacy");
    const accounts = await listAccounts("slack");
    expect(accounts[0]!.tokens).toEqual({
      SLACK_BOT_TOKEN: "xoxb-legacy",
      SLACK_USER_TOKEN: "xoxp-legacy",
    });
  });

  it("synthesizes a 'default' Notion account from NOTION_API_KEY", async () => {
    hoist.creds.set("NOTION_API_KEY", "ntn_legacy");
    const accounts = await listAccounts("notion");
    expect(accounts).toEqual([
      { slug: "default", name: "default", tokens: { NOTION_API_KEY: "ntn_legacy" } },
    ]);
  });

  it("resolve with no args returns the legacy default silently", async () => {
    hoist.creds.set("SLACK_BOT_TOKEN", "xoxb-legacy");
    const r = await resolveConnectorAccount("slack", {});
    expect(r).toEqual({
      account: { slug: "default", name: "default", tokens: { SLACK_BOT_TOKEN: "xoxb-legacy" } },
    });
  });

  it("returns [] when neither index nor legacy token exists", async () => {
    expect(await listAccounts("slack")).toEqual([]);
  });

  it("an explicitly-saved account shadows the legacy fallback", async () => {
    hoist.creds.set("SLACK_BOT_TOKEN", "xoxb-legacy");
    await saveAccount("slack", "Real", { SLACK_BOT_TOKEN: "xoxb-real" });
    const accounts = await listAccounts("slack");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.name).toBe("Real");
  });
});

describe("resolveConnectorAccount precedence (MACS-03, MACS-04)", () => {
  beforeEach(async () => {
    await saveAccount("slack", "Acme", { SLACK_BOT_TOKEN: "xoxb-acme" });
    await saveAccount("slack", "Beta", { SLACK_BOT_TOKEN: "xoxb-beta" });
  });

  it("explicit valid slug wins silently", async () => {
    const r = await resolveConnectorAccount("slack", { account: "beta" });
    expect(r).toEqual({
      account: { slug: "beta", name: "Beta", tokens: { SLACK_BOT_TOKEN: "xoxb-beta" } },
    });
  });

  it("explicit valid display name wins silently", async () => {
    const r = await resolveConnectorAccount("slack", { account: "Acme" });
    expect("account" in r && r.account.slug).toBe("acme");
  });

  it("explicit miss → error_account_required + available NAMES (not a silent fall-through)", async () => {
    const r = await resolveConnectorAccount("slack", { account: "ghost" });
    expect(r).toEqual({
      error: "error_account_required",
      available_accounts: ["Acme", "Beta"],
    });
  });

  it("≥2 accounts, no default → error_account_required + names", async () => {
    const r = await resolveConnectorAccount("slack", {});
    expect(r).toEqual({
      error: "error_account_required",
      available_accounts: ["Acme", "Beta"],
    });
  });

  it("pinned default honored when present", async () => {
    await setDefaultAccount("slack", "beta");
    const r = await resolveConnectorAccount("slack", {});
    expect("account" in r && r.account.slug).toBe("beta");
  });

  it("stale pin (default → removed account) falls through to count rules (MACS-04)", async () => {
    await setDefaultAccount("slack", "beta");
    await removeAccount("slack", "beta");
    // Only Acme remains → count rule "exactly 1" applies → silent.
    const r = await resolveConnectorAccount("slack", {});
    expect("account" in r && r.account.slug).toBe("acme");
  });

  it("stale pin with ≥2 remaining accounts still falls through to error", async () => {
    await saveAccount("slack", "Gamma", { SLACK_BOT_TOKEN: "xoxb-gamma" });
    await setDefaultAccount("slack", "ghost-slug");
    const r = await resolveConnectorAccount("slack", {});
    expect(r).toEqual({
      error: "error_account_required",
      available_accounts: ["Acme", "Beta", "Gamma"],
    });
  });

  it("explicit arg wins over a valid pinned default", async () => {
    await setDefaultAccount("slack", "beta");
    const r = await resolveConnectorAccount("slack", { account: "acme" });
    expect("account" in r && r.account.slug).toBe("acme");
  });
});

describe("resolveConnectorAccount count edges (MACS-03)", () => {
  it("0 accounts → error_no_account", async () => {
    const r = await resolveConnectorAccount("slack", {});
    expect(r).toEqual({ error: "error_no_account" });
  });

  it("exactly 1 account → silent", async () => {
    await saveAccount("slack", "Only", { SLACK_BOT_TOKEN: "xoxb-only" });
    const r = await resolveConnectorAccount("slack", {});
    expect("account" in r && r.account.slug).toBe("only");
  });
});

describe("removeAccount", () => {
  it("clears a default that pointed at the removed account", async () => {
    await saveAccount("slack", "Acme", { SLACK_BOT_TOKEN: "xoxb-acme" });
    await saveAccount("slack", "Beta", { SLACK_BOT_TOKEN: "xoxb-beta" });
    await setDefaultAccount("slack", "acme");
    await removeAccount("slack", "acme");

    expect(await getDefaultAccount("slack")).toBeUndefined();
    const accounts = await listAccounts("slack");
    expect(accounts.map((a) => a.slug)).toEqual(["beta"]);
  });

  it("preserves a default that pointed at a different account", async () => {
    await saveAccount("slack", "Acme", { SLACK_BOT_TOKEN: "xoxb-acme" });
    await saveAccount("slack", "Beta", { SLACK_BOT_TOKEN: "xoxb-beta" });
    await setDefaultAccount("slack", "beta");
    await removeAccount("slack", "acme");
    expect(await getDefaultAccount("slack")).toBe("beta");
  });
});

describe("tenant isolation (MACS-05)", () => {
  it("an account written under tenant A is invisible under tenant B", async () => {
    hoist.setTenant("alpha");
    await saveAccount("slack", "Alpha WS", { SLACK_BOT_TOKEN: "xoxb-alpha" });

    // Switch to tenant B's request scope: same backing store, different
    // key prefix → nothing visible.
    hoist.setTenant("beta");
    expect(await listAccounts("slack")).toEqual([]);
    expect(await resolveConnectorAccount("slack", {})).toEqual({ error: "error_no_account" });

    // Back to tenant A: the account is still there.
    hoist.setTenant("alpha");
    const accounts = await listAccounts("slack");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.tokens).toEqual({ SLACK_BOT_TOKEN: "xoxb-alpha" });
  });

  it("a pinned default does not leak across tenants", async () => {
    hoist.setTenant("alpha");
    await saveAccount("slack", "Alpha WS", { SLACK_BOT_TOKEN: "xoxb-alpha" });
    await setDefaultAccount("slack", "alpha-ws");

    hoist.setTenant("beta");
    expect(await getDefaultAccount("slack")).toBeUndefined();
  });
});
