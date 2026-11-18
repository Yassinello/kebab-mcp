/**
 * Kebab House — settings changes proposed from the AI conversation
 * (`kebab_config`), applied only once the owner confirms them in the browser.
 *
 *   1. `kebab_config` (action "propose") validates ONE change against the
 *      current state and stores it as an approval preview (src/core/approvals.ts,
 *      tool "kebab_config"). Nothing changes; the model gets the signed link.
 *   2. The owner opens `/approve/<id>` (admin cookie session) and approves.
 *      `decideConfigProposal` consumes the preview and applies the STORED
 *      change right away, re-validating it at that moment (a client may have
 *      been deleted since, a profile removed, the value already set…).
 *   3. The outcome (applied / failed / rejected) is kept for a while so
 *      `kebab_config` action "status" can tell the model what happened.
 *
 * What can change: the instance display name, timezone and locale; one AI
 * client's access level, profile or label; one tool on or off. Never: the
 * approval mode, keys, tokens, credentials, deleting clients.
 */

import { getContextKVStore, getCurrentTenantId } from "./request-context";
import { consume, decide, getPreview, type ApprovalSummary } from "./approvals";
import { getInstanceConfigAsync, saveInstanceConfig } from "./config";
import {
  isAccessLevel,
  listDevices,
  setDeviceAccessLevel,
  setDeviceLabel,
  setDeviceProfile,
  type AccessLevel,
  type DeviceRow,
} from "./devices";
import { DEFAULT_PROFILE, listProfiles } from "./profiles";
import { getDisabledTools, setToolDisabled } from "./tool-toggles";
import { resolveRegistryAsync } from "./registry";
import { toMsg } from "./error-utils";

/** Tool name the previews are created under (only it may consume them). */
export const CONFIG_TOOL = "kebab_config";

/** Link-spam guard: at most this many proposals per window, per instance. */
export const PROPOSAL_CAP = 10;
export const PROPOSAL_WINDOW_SECONDS = 15 * 60;

/** How long the outcome of a decided proposal stays readable by "status". */
const OUTCOME_TTL_SECONDS = 24 * 60 * 60;

const CAP_PREFIX = "config-proposals:cap:";
const OUTCOME_PREFIX = "config-proposals:outcome:";

// ── change shapes ────────────────────────────────────────────────────

export interface InstanceChange {
  displayName?: string | undefined;
  timezone?: string | undefined;
  locale?: string | undefined;
}

export interface DeviceChange {
  id: string;
  access?: AccessLevel | undefined;
  profile?: string | undefined;
  label?: string | undefined;
}

export interface ToolChange {
  name: string;
  enabled: boolean;
}

export type ConfigChange =
  | { instance: InstanceChange }
  | { device: DeviceChange }
  | { tool: ToolChange };

/** One line of the readable summary: what changes, from what to what. */
export interface ChangeLine {
  field: string;
  from: string;
  to: string;
}

export interface ValidatedChange {
  /** Normalized change, only the fields that really change. */
  change: ConfigChange;
  /** What is changed: "Instance settings", `AI client "Claude"`, `Tool "x"`. */
  target: string;
  lines: ChangeLine[];
}

export type ValidationResult = { ok: true; value: ValidatedChange } | { ok: false; error: string };

/** Who proposes the change (the MCP caller), for scoping. `null` = owner / no restriction. */
export interface ProposerScope {
  /** Device id of the caller; a restricted caller may only change its own row. */
  selfId: string | null;
  restricted: boolean;
}

const ACCESS_WORDS: Record<AccessLevel, string> = {
  read: "read only",
  memory: "read + profile and notes",
  full: "full (can also send messages and change things)",
};

const DISPLAY_NAME_MAX = 60;
const LABEL_MAX = 40;

function fail(error: string): ValidationResult {
  return { ok: false, error };
}

// ── validation ───────────────────────────────────────────────────────

/** IANA zone ("Europe/Paris", "America/Argentina/Buenos_Aires", "UTC"). */
export function normalizeTimezone(raw: string): string | null {
  const tz = raw.trim();
  if (!/^(?:UTC|Etc\/[A-Za-z0-9+-]+|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(tz)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** BCP 47 locale ("fr-FR", "en-US"), canonicalized. */
export function normalizeLocale(raw: string): string | null {
  const loc = raw.trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(loc)) return null;
  try {
    return Intl.getCanonicalLocales(loc)[0] ?? null;
  } catch {
    return null;
  }
}

function cleanText(raw: string, max: number): string | null {
  const t = raw.trim();
  if (!t || t.length > max || /[\r\n\t]/.test(t)) return null;
  return t;
}

async function validateInstance(input: InstanceChange): Promise<ValidationResult> {
  const keys = (["displayName", "timezone", "locale"] as const).filter(
    (k) => input[k] !== undefined
  );
  if (keys.length === 0) {
    return fail("Say what to change: displayName, timezone and/or locale.");
  }
  const current = await getInstanceConfigAsync(getCurrentTenantId());
  const change: InstanceChange = {};
  const lines: ChangeLine[] = [];
  if (input.displayName !== undefined) {
    const v = cleanText(input.displayName, DISPLAY_NAME_MAX);
    if (!v) return fail(`The display name must be 1 to ${DISPLAY_NAME_MAX} characters, one line.`);
    if (v !== current.displayName) {
      change.displayName = v;
      lines.push({ field: "Display name", from: current.displayName, to: v });
    }
  }
  if (input.timezone !== undefined) {
    const v = normalizeTimezone(input.timezone);
    if (!v) {
      return fail(
        `"${input.timezone}" is not a valid time zone. Use an IANA name such as "Europe/Paris" or "America/New_York".`
      );
    }
    if (v !== current.timezone) {
      change.timezone = v;
      lines.push({ field: "Time zone", from: current.timezone, to: v });
    }
  }
  if (input.locale !== undefined) {
    const v = normalizeLocale(input.locale);
    if (!v) {
      return fail(
        `"${input.locale}" is not a valid locale. Use a code such as "en-US" or "fr-FR".`
      );
    }
    if (v !== current.locale) {
      change.locale = v;
      lines.push({ field: "Locale", from: current.locale, to: v });
    }
  }
  if (lines.length === 0) return fail("Nothing to change: these settings already have this value.");
  return { ok: true, value: { change: { instance: change }, target: "Instance settings", lines } };
}

function isUsableDevice(d: DeviceRow): boolean {
  return d.label !== "corrupt entry" && !d.label.includes("(revoked");
}

async function validateDevice(
  input: DeviceChange,
  scope: ProposerScope
): Promise<ValidationResult> {
  if (getCurrentTenantId() !== null) {
    return fail("AI clients of this space are managed in the dashboard (Devices).");
  }
  const id = typeof input.id === "string" ? input.id.trim().toLowerCase() : "";
  if (input.access === undefined && input.profile === undefined && input.label === undefined) {
    return fail("Say what to change for this client: access, profile and/or label.");
  }
  if (scope.restricted && id !== scope.selfId) {
    return fail(
      "This client can only propose changes to its own settings. Other clients are changed from a client with full access, or in the dashboard (Devices)."
    );
  }
  const device = (await listDevices()).find((d) => d.tokenId === id);
  if (!device || !isUsableDevice(device)) {
    return fail(
      `No AI client with id "${input.id}". Call kebab_config with action "get" to see the ids.`
    );
  }
  const change: DeviceChange = { id };
  const lines: ChangeLine[] = [];
  if (input.access !== undefined) {
    if (!isAccessLevel(input.access)) return fail('Access must be "read", "memory" or "full".');
    const from = device.access ?? "full";
    if (input.access !== from) {
      change.access = input.access;
      lines.push({ field: "Access", from: ACCESS_WORDS[from], to: ACCESS_WORDS[input.access] });
    }
  }
  if (input.profile !== undefined) {
    const wanted = input.profile.trim().toLowerCase();
    const names = (await listProfiles()).map((p) => p.name);
    if (!names.includes(wanted)) {
      return fail(`No profile "${input.profile}". Existing profiles: ${names.join(", ")}.`);
    }
    const from = device.profile ?? DEFAULT_PROFILE;
    if (wanted !== from) {
      change.profile = wanted;
      lines.push({ field: "Profile", from, to: wanted });
    }
  }
  if (input.label !== undefined) {
    const v = cleanText(input.label, LABEL_MAX);
    if (!v) return fail(`The label must be 1 to ${LABEL_MAX} characters, one line.`);
    if (v !== device.label) {
      change.label = v;
      lines.push({ field: "Name", from: device.label, to: v });
    }
  }
  if (lines.length === 0) return fail("Nothing to change: this client already has these settings.");
  return {
    ok: true,
    value: { change: { device: change }, target: `AI client "${device.label}"`, lines },
  };
}

/** Names of the tools of every enabled connector. */
async function knownToolNames(): Promise<Set<string>> {
  const packs = await resolveRegistryAsync();
  return new Set(
    packs.filter((p) => p.enabled).flatMap((p) => p.manifest.tools.map((t) => t.name))
  );
}

async function validateTool(input: ToolChange): Promise<ValidationResult> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (typeof input.enabled !== "boolean") return fail("Say enabled: true or false.");
  if (name === CONFIG_TOOL) {
    return fail("kebab_config itself can only be turned off in the dashboard (Tools).");
  }
  if (!(await knownToolNames()).has(name)) {
    return fail(
      `No tool "${input.name}" among the active connectors. A connector that is not set up has no tools yet.`
    );
  }
  const disabled = (await getDisabledTools()).has(name);
  if (disabled === !input.enabled) {
    return fail(`Nothing to change: ${name} is already ${input.enabled ? "on" : "off"}.`);
  }
  return {
    ok: true,
    value: {
      change: { tool: { name, enabled: input.enabled } },
      target: `Tool "${name}"`,
      lines: [
        {
          field: "State",
          from: disabled ? "off" : "on",
          to: input.enabled ? "on" : "off",
        },
      ],
    },
  };
}

/** Validate one change against the current state. */
export async function validateConfigChange(
  change: unknown,
  scope: ProposerScope = { selfId: null, restricted: false }
): Promise<ValidationResult> {
  if (!change || typeof change !== "object") return fail("No change given.");
  const c = change as Record<string, unknown>;
  const kinds = (["instance", "device", "tool"] as const).filter(
    (k) => c[k] !== undefined && c[k] !== null
  );
  if (kinds.length !== 1) {
    return fail("Propose exactly one change at a time: instance, device or tool.");
  }
  const kind = kinds[0]!;
  const body = c[kind];
  if (!body || typeof body !== "object") return fail(`"${kind}" must be an object.`);
  try {
    if (kind === "instance") return await validateInstance(body as InstanceChange);
    if (kind === "device") return await validateDevice(body as DeviceChange, scope);
    return await validateTool(body as ToolChange);
  } catch (err) {
    return fail(`Could not read the current settings (${toMsg(err)}).`);
  }
}

/** Readable approval summary for the /approve page. */
export function proposalSummary(v: ValidatedChange): ApprovalSummary {
  return {
    account: null,
    recipient: v.target,
    text: v.lines.map((l) => `${l.field}: ${l.from} → ${l.to}`).join("\n"),
    details: {},
  };
}

// ── rate cap ─────────────────────────────────────────────────────────

/**
 * Take one proposal slot in the current window. `false` when the cap is
 * reached (nothing is stored then).
 */
export async function takeProposalSlot(now = Date.now()): Promise<boolean> {
  const kv = getContextKVStore();
  const windowId = Math.floor(now / (PROPOSAL_WINDOW_SECONDS * 1000));
  const key = `${CAP_PREFIX}${windowId}`;
  let count: number;
  if (typeof kv.incr === "function") {
    count = await kv.incr(key, { ttlSeconds: PROPOSAL_WINDOW_SECONDS });
  } else {
    count = (parseInt((await kv.get(key)) ?? "0", 10) || 0) + 1;
    await kv.set(key, String(count), PROPOSAL_WINDOW_SECONDS);
  }
  return count <= PROPOSAL_CAP;
}

// ── apply ────────────────────────────────────────────────────────────

/** Write a validated change. */
async function writeChange(change: ConfigChange): Promise<void> {
  if ("instance" in change) {
    const patch: { displayName?: string; timezone?: string; locale?: string } = {};
    const i = change.instance;
    if (i.displayName !== undefined) patch.displayName = i.displayName;
    if (i.timezone !== undefined) patch.timezone = i.timezone;
    if (i.locale !== undefined) patch.locale = i.locale;
    await saveInstanceConfig(patch, getCurrentTenantId());
    return;
  }
  if ("device" in change) {
    const d = change.device;
    if (d.label !== undefined) await setDeviceLabel(d.id, d.label);
    if (d.profile !== undefined) {
      await setDeviceProfile(d.id, d.profile === DEFAULT_PROFILE ? null : d.profile);
    }
    if (d.access !== undefined) await setDeviceAccessLevel(d.id, d.access);
    return;
  }
  await setToolDisabled(change.tool.name, !change.tool.enabled);
}

export type ApplyResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Apply a stored change after re-validating it now. The owner already
 * confirmed it, so the caller scope does not apply; a change that is
 * already in place counts as applied.
 */
export async function applyConfigChange(stored: unknown): Promise<ApplyResult> {
  const v = await validateConfigChange(stored);
  if (!v.ok) {
    if (v.error.startsWith("Nothing to change")) {
      return { ok: true, message: "Already in place: nothing needed to change." };
    }
    return { ok: false, error: v.error };
  }
  try {
    await writeChange(v.value.change);
  } catch (err) {
    return { ok: false, error: `The change could not be saved (${toMsg(err)}).` };
  }
  const what = v.value.lines.map((l) => `${l.field}: ${l.to}`).join(", ");
  return { ok: true, message: `${v.value.target} updated (${what}).` };
}

// ── outcome ──────────────────────────────────────────────────────────

export interface ProposalOutcome {
  status: "applied" | "failed" | "rejected";
  message: string;
  at: string;
}

async function recordOutcome(id: string, outcome: Omit<ProposalOutcome, "at">): Promise<void> {
  const rec: ProposalOutcome = { ...outcome, at: new Date().toISOString() };
  await getContextKVStore().set(`${OUTCOME_PREFIX}${id}`, JSON.stringify(rec), OUTCOME_TTL_SECONDS);
}

export async function readProposalOutcome(id: string): Promise<ProposalOutcome | null> {
  const raw = await getContextKVStore().get(`${OUTCOME_PREFIX}${id}`);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as ProposalOutcome;
    return o && typeof o.status === "string" ? o : null;
  } catch {
    return null;
  }
}

export type ConfigDecisionResult =
  | { ok: true; status: "applied" | "rejected"; message: string }
  | {
      ok: false;
      error: "not_found" | "already_consumed" | "apply_failed";
      message?: string;
    };

/**
 * The owner's decision on a kebab_config preview (called by
 * POST /api/approvals/<id>, inside the tenant the link was signed for).
 * Approve = consume once + apply the stored change now; reject = delete.
 */
export async function decideConfigProposal(
  id: string,
  decision: "approve" | "reject"
): Promise<ConfigDecisionResult> {
  const decided = await decide(id, decision);
  if (!decided.ok) return { ok: false, error: decided.reason };
  if (decision === "reject") {
    await recordOutcome(id, { status: "rejected", message: "The owner rejected this change." });
    return { ok: true, status: "rejected", message: "Rejected. Nothing changed." };
  }
  const taken = await consume(id, CONFIG_TOOL);
  if (!taken.ok) {
    return {
      ok: false,
      error: taken.reason === "already_consumed" ? "already_consumed" : "not_found",
    };
  }
  const applied = await applyConfigChange(taken.record.payload.change);
  if (!applied.ok) {
    await recordOutcome(id, { status: "failed", message: applied.error });
    return { ok: false, error: "apply_failed", message: applied.error };
  }
  await recordOutcome(id, { status: "applied", message: applied.message });
  return { ok: true, status: "applied", message: applied.message };
}

/** Whether a preview id belongs to a kebab_config proposal (still stored). */
export async function isConfigProposal(id: string): Promise<boolean> {
  return (await getPreview(id))?.tool === CONFIG_TOOL;
}

// ── connectors ───────────────────────────────────────────────────────

export interface ConnectorStatus {
  id: string;
  label: string;
  /** active · needs_setup (credentials missing) · off (turned off by the operator). */
  status: "active" | "needs_setup" | "off";
}

/** Status of every non-core connector, in registry order. */
export async function listConnectorStatuses(): Promise<ConnectorStatus[]> {
  const packs = await resolveRegistryAsync();
  return packs
    .filter((p) => !p.manifest.core)
    .map((p) => ({
      id: p.manifest.id,
      label: p.manifest.label,
      status: p.enabled
        ? ("active" as const)
        : /^(disabled via|not listed in)/.test(p.reason)
          ? ("off" as const)
          : ("needs_setup" as const),
    }));
}
