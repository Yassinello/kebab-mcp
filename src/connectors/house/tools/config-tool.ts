import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getCallerMeta } from "@/core/token-scope";
import { getCurrentTenantId } from "@/core/request-context";
import { getInstanceConfigAsync } from "@/core/config";
import { listDevices, type DeviceRow } from "@/core/devices";
import { listProfiles } from "@/core/profiles";
import { getDisabledTools } from "@/core/tool-toggles";
import {
  APPROVAL_TTL_SECONDS,
  buildApprovalUrl,
  createPreview,
  getPreview,
  isApprovalId,
} from "@/core/approvals";
import {
  CONFIG_TOOL,
  PROPOSAL_CAP,
  PROPOSAL_WINDOW_SECONDS,
  listConnectorStatuses,
  proposalSummary,
  readProposalOutcome,
  takeProposalSlot,
  validateConfigChange,
} from "@/core/config-proposals";
import { toMsg } from "@/core/error-utils";
import { dashboardLink } from "@/connectors/context/tools/setup";
import { callerView } from "./house-tools";

/**
 * `kebab_config` — the owner's settings, readable and changeable from the
 * conversation within the trust model: the tool only reads, or stores a
 * proposal; the change is applied when the owner confirms it in the
 * browser (src/core/config-proposals.ts). Never returns a token, secret or
 * credential value.
 */

export const NOT_OFFERED =
  "Not available here, only in the dashboard: the approval mode, the admin key, tokens and connector credentials, deleting or adding AI clients, and the approval history.";

export const kebabConfigSchema = {
  action: z
    .enum(["get", "propose", "status"])
    .describe(
      "get: the current settings. propose: prepare ONE change (instance, device or tool) and get a confirmation link. status: what happened to a proposal (preview_id)."
    ),
  instance: z
    .object({
      displayName: z.string().max(200).optional(),
      timezone: z.string().max(100).optional().describe('IANA time zone, e.g. "Europe/Paris".'),
      locale: z.string().max(35).optional().describe('e.g. "en-US", "fr-FR".'),
    })
    .optional()
    .describe("propose: instance settings to change."),
  device: z
    .object({
      id: z.string().max(64).describe('Client id from action "get".'),
      access: z.enum(["read", "memory", "full"]).optional(),
      profile: z.string().max(64).optional().describe("Profile this client uses."),
      label: z.string().max(200).optional().describe("New name of the client."),
    })
    .optional()
    .describe("propose: one AI client's settings to change."),
  tool: z
    .object({
      name: z.string().max(100),
      enabled: z.boolean(),
    })
    .optional()
    .describe("propose: turn one tool on or off."),
  preview_id: z.string().max(64).optional().describe("status: the id returned by propose."),
};

type Args = {
  action: "get" | "propose" | "status";
  instance?:
    | {
        displayName?: string | undefined;
        timezone?: string | undefined;
        locale?: string | undefined;
      }
    | undefined;
  device?:
    | {
        id: string;
        access?: "read" | "memory" | "full" | undefined;
        profile?: string | undefined;
        label?: string | undefined;
      }
    | undefined;
  tool?: { name: string; enabled: boolean } | undefined;
  preview_id?: string | undefined;
};

function json(data: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Restricted callers (read / memory access, or a connector scope) only see and change their own client. */
function proposerScope(): { selfId: string | null; restricted: boolean } {
  const view = callerView();
  return { selfId: getCallerMeta()?.tokenId ?? null, restricted: !view.full };
}

function clientRow(d: DeviceRow, selfId: string | null) {
  return {
    id: d.tokenId,
    label: d.label,
    access: d.access ?? "full",
    profile: d.profile ?? "default",
    last_seen: d.lastSeenAt,
    ...(d.tokenId === selfId ? { this_client: true } : {}),
  };
}

async function handleGet(): Promise<ToolResult> {
  const scope = proposerScope();
  const rootOnly = getCurrentTenantId() === null;
  const [cfg, devices, disabled, connectors, profiles] = await Promise.all([
    getInstanceConfigAsync(getCurrentTenantId()),
    rootOnly ? listDevices().catch(() => [] as DeviceRow[]) : Promise.resolve([] as DeviceRow[]),
    getDisabledTools(),
    listConnectorStatuses().catch(() => []),
    listProfiles().catch(() => []),
  ]);
  const usable = devices.filter(
    (d) => d.label !== "corrupt entry" && !d.label.includes("(revoked")
  );
  const visible = scope.restricted ? usable.filter((d) => d.tokenId === scope.selfId) : usable;
  return json({
    instance: {
      displayName: cfg.displayName,
      timezone: cfg.timezone,
      locale: cfg.locale,
    },
    clients: visible.map((d) => clientRow(d, scope.selfId)),
    clients_shown: scope.restricted ? "this client only" : "all",
    profiles: profiles.map((p) => p.name),
    disabled_tools: [...disabled].sort(),
    connectors: connectors.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status === "needs_setup" ? "needs setup" : c.status,
      ...(c.status === "needs_setup"
        ? { setup_link: dashboardLink("connectors", { connector: c.id }) }
        : {}),
    })),
    how_to_change:
      'Call kebab_config with action "propose" and ONE of: instance {displayName?, timezone?, locale?}, device {id, access?, profile?, label?}, tool {name, enabled}. The owner confirms each change in the browser.',
    connector_setup:
      "Connector credentials are entered only in the dashboard: give the owner the setup_link, never ask for a password, token or key in the conversation.",
    not_offered: NOT_OFFERED,
  });
}

async function handlePropose(args: Args): Promise<ToolResult> {
  const change = args.instance
    ? { instance: args.instance }
    : args.device
      ? { device: args.device }
      : args.tool
        ? { tool: args.tool }
        : null;
  const given = [args.instance, args.device, args.tool].filter(Boolean).length;
  if (!change || given !== 1) {
    return json(
      {
        changed: false,
        error: "Propose exactly one change at a time: instance, device or tool.",
        not_offered: NOT_OFFERED,
      },
      true
    );
  }
  const v = await validateConfigChange(change, proposerScope());
  if (!v.ok) return json({ changed: false, error: v.error }, true);

  let url: string;
  let previewId: string;
  let expiresAt: number;
  try {
    if (!(await takeProposalSlot())) {
      return json(
        {
          changed: false,
          error: `Too many proposals: at most ${PROPOSAL_CAP} every ${PROPOSAL_WINDOW_SECONDS / 60} minutes. Wait, or make the change in the dashboard.`,
        },
        true
      );
    }
    const meta = getCallerMeta();
    const rec = await createPreview({
      tool: CONFIG_TOOL,
      summary: proposalSummary(v.value),
      payload: { change: v.value.change },
      requestedBy: meta?.label ?? meta?.tokenId ?? null,
    });
    url = await buildApprovalUrl(rec.id);
    previewId = rec.id;
    expiresAt = rec.expiresAt;
  } catch (err) {
    return json(
      {
        changed: false,
        error: `Could not create the confirmation link (${toMsg(err)}). Make the change in the dashboard instead.`,
      },
      true
    );
  }
  return json({
    changed: false,
    confirmation_required: true,
    target: v.value.target,
    changes: v.value.lines,
    preview_id: previewId,
    confirmation_url: url,
    expires_at: new Date(expiresAt).toISOString(),
    next_step:
      `Nothing has changed yet. Give the owner this link: ${url} . They check the change and confirm it in their browser; it is applied right then. ` +
      `Do not say it is done before that. When they say they confirmed, call kebab_config with action "status" and preview_id "${previewId}". ` +
      `The link expires in ${APPROVAL_TTL_SECONDS / 60} minutes.`,
  });
}

async function handleStatus(args: Args): Promise<ToolResult> {
  const id = args.preview_id;
  if (!isApprovalId(id)) {
    return json({ error: 'Give the preview_id returned by action "propose".' }, true);
  }
  const outcome = await readProposalOutcome(id);
  if (outcome) {
    return json({
      preview_id: id,
      status: outcome.status,
      message: outcome.message,
      ...(outcome.status === "failed"
        ? {
            next_step:
              "Tell the owner it was not applied and why. Propose again if it still makes sense.",
          }
        : {}),
    });
  }
  const rec = await getPreview(id);
  if (!rec || rec.tool !== CONFIG_TOOL) {
    return json({
      preview_id: id,
      status: "expired",
      message: "This proposal expired or does not exist. Nothing changed. Propose again if needed.",
    });
  }
  if (rec.status === "consumed") {
    return json({ preview_id: id, status: "applied", message: "The change was applied." });
  }
  const url = await buildApprovalUrl(rec.id);
  return json({
    preview_id: id,
    status: "pending",
    message: "Not confirmed yet: nothing has changed.",
    confirmation_url: url,
    expires_at: new Date(rec.expiresAt).toISOString(),
  });
}

export async function handleKebabConfig(args: Args): Promise<ToolResult> {
  if (args.action === "get") return handleGet();
  if (args.action === "propose") return handlePropose(args);
  return handleStatus(args);
}
