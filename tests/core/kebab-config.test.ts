/**
 * kebab_config — settings read and changed from the conversation, applied
 * only once the owner confirms on /approve (src/core/config-proposals.ts).
 *
 * Tool level: get (scoping, no secrets), propose (validation, one change,
 * cap, nothing changes), status. Through the approvals route: approve
 * applies the STORED change once and re-validates it; reject; other tools'
 * previews behave as before.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── in-memory state behind the mocks ────────────────────────────────

const kvStore = new Map<string, string>();
let envVars: Record<string, string> = {};
let currentTenantId: string | null = null;

const instance = { displayName: "Kebab House", timezone: "Europe/Paris", locale: "fr-FR" };
type Dev = {
  tokenId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  connectors: string[] | null;
  skillTags: string[] | null;
  profile: string | null;
  access: "read" | "memory" | "full";
};
let devices: Dev[] = [];
const disabledTools = new Set<string>();
let registryPacks: unknown[] = [];

vi.mock("@/core/request-context", () => {
  const scoped = (k: string) => `${currentTenantId ?? ""}:${k}`;
  const kv = {
    kind: "filesystem" as const,
    get: async (k: string) => kvStore.get(scoped(k)) ?? null,
    set: async (k: string, v: string) => void kvStore.set(scoped(k), v),
    delete: async (k: string) => void kvStore.delete(scoped(k)),
    list: async () => [],
    incr: async (k: string) => {
      const n = parseInt(kvStore.get(scoped(k)) ?? "0", 10) + 1;
      kvStore.set(scoped(k), String(n));
      return n;
    },
    setIfNotExists: async (k: string, v: string) => {
      if (kvStore.has(scoped(k))) return { ok: false as const, existing: kvStore.get(scoped(k))! };
      kvStore.set(scoped(k), v);
      return { ok: true as const };
    },
  };
  return {
    getContextKVStore: () => kv,
    getCurrentTenantId: () => currentTenantId,
    getRequestOrigin: () => null,
    runWithTenant: async <T>(tenantId: string, fn: () => T) => {
      const prev = currentTenantId;
      currentTenantId = tenantId;
      try {
        return await fn();
      } finally {
        currentTenantId = prev;
      }
    },
    requestContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
    getCredential: (envKey: string) => envVars[envKey],
    runWithCredentials: <T>(_creds: Record<string, string>, fn: () => T) => fn(),
  };
});

vi.mock("@/core/config-facade", () => ({
  getConfig: (key: string) => envVars[key],
  getConfigInt: (key: string, fallback: number) => {
    const n = parseInt(envVars[key] ?? "", 10);
    return Number.isFinite(n) ? n : fallback;
  },
}));

vi.mock("@/core/signing-secret", async (orig) => ({
  ...(await orig<typeof import("@/core/signing-secret")>()),
  getSigningSecret: async () => "1".repeat(64),
}));

vi.mock("@/core/config", () => ({
  getInstanceConfigAsync: async () => ({ ...instance, contextPath: "System/context.md" }),
  saveInstanceConfig: vi.fn(async (patch: Partial<typeof instance>) => {
    Object.assign(instance, patch);
  }),
}));

vi.mock("@/core/devices", async (orig) => ({
  ...(await orig<typeof import("@/core/devices")>()),
  listDevices: async () => devices.map((d) => ({ ...d })),
  setDeviceAccessLevel: vi.fn(async (id: string, access: Dev["access"]) => {
    const d = devices.find((x) => x.tokenId === id);
    if (d) d.access = access;
  }),
  setDeviceProfile: vi.fn(async (id: string, profile: string | null) => {
    const d = devices.find((x) => x.tokenId === id);
    if (d) d.profile = profile;
  }),
  setDeviceLabel: vi.fn(async (id: string, label: string) => {
    const d = devices.find((x) => x.tokenId === id);
    if (d) d.label = label;
  }),
}));

vi.mock("@/core/profiles", async (orig) => ({
  ...(await orig<typeof import("@/core/profiles")>()),
  listProfiles: async () => [{ name: "default" }, { name: "work" }],
}));

vi.mock("@/core/tool-toggles", () => ({
  getDisabledTools: async () => new Set(disabledTools),
  setToolDisabled: vi.fn(async (name: string, disabled: boolean) => {
    if (disabled) disabledTools.add(name);
    else disabledTools.delete(name);
  }),
}));

vi.mock("@/core/registry", async (orig) => ({
  ...(await orig<typeof import("@/core/registry")>()),
  resolveRegistryAsync: async () => registryPacks,
}));

type Meta = {
  tokenId: string | null;
  label: string | null;
  profile: string | null;
  access: "read" | "memory" | "full";
  writeAllowed: boolean;
};
const caller: { meta: Meta | null } = { meta: null };
vi.mock("@/core/token-scope", async (orig) => ({
  ...(await orig<typeof import("@/core/token-scope")>()),
  getCallerMeta: () => caller.meta,
}));

import { POST } from "../../app/api/approvals/[id]/route";
import { handleKebabConfig } from "@/connectors/house/tools/config-tool";
import { houseConnector } from "@/connectors/house/manifest";
import { createPreview, getPreview, signApproval } from "@/core/approvals";
import { PROPOSAL_CAP } from "@/core/config-proposals";
import { isToolAllowedForAccess } from "@/core/tool-access";
import { saveInstanceConfig } from "@/core/config";

// ── helpers ──────────────────────────────────────────────────────────

const ADMIN = "admin-token-for-tests";
const STATIC_TOKEN = "static-mcp-token-value-for-tests-0123456789";

function out(r: { content: { type: string; text?: string }[]; isError?: boolean }) {
  return JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
}

async function call(args: Record<string, unknown>) {
  return handleKebabConfig(args as Parameters<typeof handleKebabConfig>[0]);
}

function meta(tokenId: string, access: Meta["access"]): Meta {
  return { tokenId, label: "Claude", profile: null, access, writeAllowed: access === "full" };
}

/** Approve or reject on /approve, as the owner's browser does. */
async function decideInBrowser(url: string, decision: "approve" | "reject"): Promise<Response> {
  const u = new URL(url);
  const id = u.pathname.split("/").pop()!;
  const req = new Request(`https://kebab.test/api/approvals/${id}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "kebab.test",
      cookie: `kebab_admin_token=${ADMIN}`,
      "sec-fetch-site": "same-origin",
      origin: "https://kebab.test",
    },
    body: JSON.stringify({ decision, sig: u.searchParams.get("sig"), tenant: null }),
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

async function propose(args: Record<string, unknown>) {
  const res = out(await call({ action: "propose", ...args }));
  expect(res.error).toBeUndefined();
  return res as { preview_id: string; confirmation_url: string; next_step: string };
}

beforeEach(() => {
  kvStore.clear();
  envVars = {
    ADMIN_AUTH_TOKEN: ADMIN,
    MCP_AUTH_TOKEN: STATIC_TOKEN,
    KEBAB_PUBLIC_URL: "https://kebab.test",
  };
  currentTenantId = null;
  caller.meta = null;
  Object.assign(instance, {
    displayName: "Kebab House",
    timezone: "Europe/Paris",
    locale: "fr-FR",
  });
  devices = [
    {
      tokenId: "aaaa1111",
      label: "Claude",
      createdAt: "2026-10-01",
      lastSeenAt: "2026-11-17T10:00:00Z",
      connectors: null,
      skillTags: null,
      profile: null,
      access: "read",
    },
    {
      tokenId: "bbbb2222",
      label: "Laptop",
      createdAt: "2026-10-02",
      lastSeenAt: null,
      connectors: null,
      skillTags: null,
      profile: "work",
      access: "full",
    },
  ];
  disabledTools.clear();
  disabledTools.add("vault_delete");
  registryPacks = [
    {
      manifest: { id: "house", label: "Views", core: true, tools: [{ name: "kebab_config" }] },
      enabled: true,
      reason: "active",
    },
    {
      manifest: {
        id: "vault",
        label: "Memory Vault",
        tools: [{ name: "vault_read" }, { name: "vault_delete" }],
      },
      enabled: true,
      reason: "active",
    },
    {
      manifest: { id: "google", label: "Google Workspace", tools: [] },
      enabled: false,
      reason: "missing env: GOOGLE_CLIENT_ID",
    },
    {
      manifest: { id: "slack", label: "Slack", tools: [] },
      enabled: false,
      reason: "disabled via MYMCP_DISABLE_SLACK",
    },
  ];
  vi.mocked(saveInstanceConfig).mockClear();
});

// ── the tool definition ──────────────────────────────────────────────

describe("kebab_config — definition", () => {
  const def = houseConnector.tools.find((t) => t.name === "kebab_config")!;

  it("is offered to every access level (it only reads or stores a proposal)", () => {
    expect(def.destructive).toBe(false);
    expect(def.adminOnly).toBeFalsy();
    for (const access of ["read", "memory", "full"] as const) {
      expect(isToolAllowedForAccess(def, access)).toBe(true);
    }
  });

  it("says what is not offered, so the model routes it to the dashboard", () => {
    expect(def.description).toMatch(/approval mode/);
    expect(def.description).toMatch(/admin key/);
    expect(def.description).toMatch(/credentials/);
    expect(def.description).toMatch(/deleting clients/);
    expect(def.description).toMatch(/approval history/);
  });

  it("server instructions name kebab_config and the browser confirmation", () => {
    const text = houseConnector.instructions!();
    expect(text).toMatch(/kebab_config/);
    expect(text).toMatch(/confirms it/);
    expect(text).toMatch(/never in the chat/);
  });
});

// ── get ──────────────────────────────────────────────────────────────

describe("kebab_config get", () => {
  it("returns the owner's settings, every client, turned-off tools and connector status", async () => {
    const r = out(await call({ action: "get" }));
    expect(r.instance).toEqual({
      displayName: "Kebab House",
      timezone: "Europe/Paris",
      locale: "fr-FR",
    });
    expect(r.clients_shown).toBe("all");
    expect((r.clients as { id: string }[]).map((c) => c.id)).toEqual(["aaaa1111", "bbbb2222"]);
    expect((r.clients as Record<string, unknown>[])[1]).toEqual({
      id: "bbbb2222",
      label: "Laptop",
      access: "full",
      profile: "work",
      last_seen: null,
    });
    expect(r.disabled_tools).toEqual(["vault_delete"]);
    expect(r.profiles).toEqual(["default", "work"]);
    expect(r.connectors).toEqual([
      { id: "vault", label: "Memory Vault", status: "active" },
      {
        id: "google",
        label: "Google Workspace",
        status: "needs setup",
        setup_link: "https://kebab.test/config?tab=connectors&connector=google",
      },
      { id: "slack", label: "Slack", status: "off" },
    ]);
    expect(String(r.not_offered)).toMatch(/approval mode/);
  });

  it("a read or memory client only sees its own client row", async () => {
    for (const access of ["read", "memory"] as const) {
      caller.meta = meta("aaaa1111", access);
      const r = out(await call({ action: "get" }));
      expect(r.clients_shown).toBe("this client only");
      expect(r.clients).toEqual([
        {
          id: "aaaa1111",
          label: "Claude",
          access: "read",
          profile: "default",
          last_seen: "2026-11-17T10:00:00Z",
          this_client: true,
        },
      ]);
    }
    caller.meta = meta("bbbb2222", "full");
    expect((out(await call({ action: "get" })).clients as unknown[]).length).toBe(2);
  });

  it("never returns a token, key or credential value", async () => {
    envVars.GOOGLE_CLIENT_SECRET = "google-secret-value-for-tests";
    const text = (await call({ action: "get" })).content[0]!.text as string;
    for (const secret of [ADMIN, STATIC_TOKEN, "google-secret-value-for-tests", "1".repeat(64)]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/"(token|secret|password|api_key)"/i);
  });
});

// ── propose ──────────────────────────────────────────────────────────

describe("kebab_config propose", () => {
  it("creates a pending proposal with a readable summary and a signed link; nothing changes", async () => {
    const r = await propose({ instance: { timezone: "America/New_York" } });
    expect(r.confirmation_url).toMatch(
      new RegExp(`^https://kebab\\.test/approve/${r.preview_id}\\?sig=[a-f0-9]{64}$`)
    );
    expect(r.next_step).toMatch(/Nothing has changed yet/);
    expect(r.next_step).toMatch(/confirm it in their browser/);
    expect(r.next_step).toContain(`action "status" and preview_id "${r.preview_id}"`);
    expect((r as unknown as Record<string, unknown>).changes).toEqual([
      { field: "Time zone", from: "Europe/Paris", to: "America/New_York" },
    ]);
    const rec = await getPreview(r.preview_id);
    expect(rec?.tool).toBe("kebab_config");
    expect(rec?.status).toBe("pending");
    expect(rec?.summary.text).toBe("Time zone: Europe/Paris → America/New_York");
    expect(rec?.summary.recipient).toBe("Instance settings");
    expect(instance.timezone).toBe("Europe/Paris");
    expect(saveInstanceConfig).not.toHaveBeenCalled();
  });

  it("validates time zone, locale, client, profile and tool, and refuses no-ops", async () => {
    const err = async (args: Record<string, unknown>) => {
      const r = await call({ action: "propose", ...args });
      expect(r.isError).toBe(true);
      return String(out(r).error);
    };
    expect(await err({ instance: { timezone: "Mars/Olympus" } })).toMatch(/not a valid time zone/);
    expect(await err({ instance: { timezone: "Europe/Paris" } })).toMatch(/Nothing to change/);
    expect(await err({ instance: { locale: "not a locale" } })).toMatch(/not a valid locale/);
    expect(await err({ instance: {} })).toMatch(/Say what to change/);
    expect(await err({ device: { id: "cccc3333", access: "full" } })).toMatch(/No AI client/);
    expect(await err({ device: { id: "bbbb2222", profile: "nope" } })).toMatch(/No profile "nope"/);
    expect(await err({ device: { id: "bbbb2222", access: "full" } })).toMatch(/Nothing to change/);
    expect(await err({ tool: { name: "made_up_tool", enabled: false } })).toMatch(/No tool/);
    expect(await err({ tool: { name: "vault_delete", enabled: false } })).toMatch(/already off/);
    expect(await err({ tool: { name: "kebab_config", enabled: false } })).toMatch(/dashboard/);
    expect(
      await err({ instance: { timezone: "UTC" }, tool: { name: "vault_read", enabled: false } })
    ).toMatch(/exactly one change/);
    expect(await err({})).toMatch(/exactly one change/);
    expect(kvStore.size).toBe(0);
  });

  it("a restricted client may only propose changes to its own client", async () => {
    caller.meta = meta("aaaa1111", "read");
    const r = await call({ action: "propose", device: { id: "bbbb2222", access: "read" } });
    expect(String(out(r).error)).toMatch(/only propose changes to its own settings/);
    // Its own access: the owner decides on the link.
    const own = await propose({ device: { id: "aaaa1111", access: "full" } });
    const rec = await getPreview(own.preview_id);
    expect(rec?.summary.recipient).toBe('AI client "Claude"');
    expect(rec?.summary.text).toMatch(/^Access: read only → full/);
    expect(rec?.requestedBy).toBe("Claude");
  });

  it(`caps proposals at ${PROPOSAL_CAP} per window`, async () => {
    for (let i = 0; i < PROPOSAL_CAP; i++) {
      await propose({ instance: { displayName: `Name ${i}` } });
    }
    const r = await call({ action: "propose", instance: { displayName: "One too many" } });
    expect(r.isError).toBe(true);
    expect(String(out(r).error)).toMatch(/Too many proposals/);
  });
});

// ── apply on approve (through the approvals route) ───────────────────

describe("kebab_config — applied when the owner approves on /approve", () => {
  it("applies the stored change once and status reports it", async () => {
    const r = await propose({ instance: { timezone: "America/New_York", locale: "en-US" } });
    expect(out(await call({ action: "status", preview_id: r.preview_id })).status).toBe("pending");

    const res = await decideInBrowser(r.confirmation_url, "approve");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: "applied" });
    expect(String(body.message)).toMatch(/Instance settings updated/);
    expect(instance).toMatchObject({ timezone: "America/New_York", locale: "en-US" });
    expect(saveInstanceConfig).toHaveBeenCalledTimes(1);

    // Single use.
    const again = await decideInBrowser(r.confirmation_url, "approve");
    expect(again.status).toBe(409);
    expect(saveInstanceConfig).toHaveBeenCalledTimes(1);

    const status = out(await call({ action: "status", preview_id: r.preview_id }));
    expect(status).toMatchObject({ status: "applied" });
  });

  it("applies device and tool changes", async () => {
    const d = await propose({
      device: { id: "bbbb2222", profile: "default", label: "Work laptop" },
    });
    expect((await decideInBrowser(d.confirmation_url, "approve")).status).toBe(200);
    expect(devices[1]).toMatchObject({ profile: null, label: "Work laptop" });

    const t = await propose({ tool: { name: "vault_delete", enabled: true } });
    expect((await decideInBrowser(t.confirmation_url, "approve")).status).toBe(200);
    expect(disabledTools.has("vault_delete")).toBe(false);
  });

  it("re-validates at approval: a deleted client is not changed", async () => {
    const r = await propose({ device: { id: "bbbb2222", access: "read" } });
    devices = devices.filter((x) => x.tokenId !== "bbbb2222");
    const res = await decideInBrowser(r.confirmation_url, "approve");
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, error: "apply_failed" });
    expect(String(body.message)).toMatch(/No AI client/);
    const status = out(await call({ action: "status", preview_id: r.preview_id }));
    expect(status).toMatchObject({ status: "failed" });
    expect(String(status.message)).toMatch(/No AI client/);
  });

  it("a change already made meanwhile counts as applied", async () => {
    const r = await propose({ instance: { displayName: "My hub" } });
    instance.displayName = "My hub";
    const res = await decideInBrowser(r.confirmation_url, "approve");
    expect(await res.json()).toMatchObject({ ok: true, status: "applied" });
    expect(saveInstanceConfig).not.toHaveBeenCalled();
  });

  it("reject deletes it, changes nothing, and status says rejected", async () => {
    const r = await propose({ instance: { timezone: "Asia/Tokyo" } });
    const res = await decideInBrowser(r.confirmation_url, "reject");
    expect(await res.json()).toMatchObject({ ok: true, status: "rejected" });
    expect(await getPreview(r.preview_id)).toBeNull();
    expect(instance.timezone).toBe("Europe/Paris");
    expect(out(await call({ action: "status", preview_id: r.preview_id })).status).toBe("rejected");
  });

  it("status of an unknown or expired proposal is expired", async () => {
    expect(out(await call({ action: "status", preview_id: "0".repeat(32) })).status).toBe(
      "expired"
    );
    expect((await call({ action: "status", preview_id: "nope" })).isError).toBe(true);
  });

  it("other tools' previews are only unlocked on approve, as before", async () => {
    const rec = await createPreview({
      tool: "whatsapp_send_message",
      summary: { account: "wa1", recipient: "A contact", text: "Hi", details: {} },
      payload: { args: { text: "Hi" }, change: { instance: { timezone: "Asia/Tokyo" } } },
    });
    const sig = await signApproval(rec.id, null);
    const url = `https://kebab.test/approve/${rec.id}?sig=${sig}`;
    const res = await decideInBrowser(url, "approve");
    expect(await res.json()).toEqual({ ok: true, status: "approved" });
    expect((await getPreview(rec.id))?.status).toBe("approved");
    expect(instance.timezone).toBe("Europe/Paris");
    // kebab_config cannot read or report another tool's preview.
    expect(out(await call({ action: "status", preview_id: rec.id })).status).toBe("expired");
  });
});
