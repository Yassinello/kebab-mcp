import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getConfig } from "@/core/config-facade";
import { getInstanceConfigAsync } from "@/core/config";
import { getCallerMeta } from "@/core/token-scope";
import { toMsg } from "@/core/error-utils";
import {
  DEFAULT_PROFILE,
  MAX_PROFILE_BYTES,
  ProfileError,
  getDefaultProfileMode,
  getProfileContent,
  profileExists,
  saveProfile,
} from "@/core/profiles";

/**
 * Kebab House phase 0 (CTX-01/02/05) — `my_context` and `my_context_update`.
 *
 * Resolution order for `my_context` (CTX-02):
 *   1. the profile bound to the calling token (device entry `profile`);
 *   2. the default profile — inline Markdown in KV when its mode is inline;
 *   3. the vault file at the configured `contextPath` when the default
 *      profile is in vault mode and the vault connector is configured;
 *   4. a short help message pointing at /config → Settings.
 */

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

const EMPTY_HELP =
  "No personal profile yet. Ask the user a few questions (role, current projects, preferences, how they like answers), " +
  "then save a short Markdown profile with my_context_update — or the user can write it in the Kebab House dashboard " +
  "(/config → Settings → Profile).";

/** The profile name this call should use (bound profile if it exists, else default). */
async function resolveProfileName(): Promise<string> {
  const bound = getCallerMeta()?.profile ?? null;
  if (bound && bound !== DEFAULT_PROFILE && (await profileExists(bound))) return bound;
  return DEFAULT_PROFILE;
}

function vaultConfigured(): boolean {
  return Boolean(getConfig("GITHUB_PAT") && getConfig("GITHUB_REPO"));
}

async function readDefaultFromVault(): Promise<string | null> {
  if (!vaultConfigured()) return null;
  const cfg = await getInstanceConfigAsync();
  const path = cfg.contextPath || "System/context.md";
  try {
    // Lazy import: the vault library is only loaded for vault-mode profiles.
    const { vaultRead } = await import("@/connectors/vault/lib/github");
    const file = await vaultRead(path);
    return file.content;
  } catch (err) {
    const msg = toMsg(err);
    if (/not found/i.test(msg)) {
      return `Profile file not found at "${path}" in the vault. Create it, or switch the profile to inline in /config → Settings.`;
    }
    throw err;
  }
}

export const myContextSchema = {};

export async function handleMyContext(): Promise<ToolResult> {
  const name = await resolveProfileName();
  if (name !== DEFAULT_PROFILE) {
    const content = (await getProfileContent(name)) ?? "";
    return text(content.trim() ? `<!-- profile: ${name} -->\n${content}` : EMPTY_HELP);
  }
  const mode = await getDefaultProfileMode();
  if (mode === "vault") {
    const fromVault = await readDefaultFromVault();
    if (fromVault !== null) return text(fromVault);
  }
  const inline = (await getProfileContent(DEFAULT_PROFILE)) ?? "";
  return text(inline.trim() ? inline : EMPTY_HELP);
}

export const myContextUpdateSchema = {
  mode: z
    .enum(["append", "replace"])
    .describe(
      "append: add the content at the end of the profile (default). replace: overwrite the whole profile."
    )
    .optional(),
  content: z
    .string()
    .min(1)
    .max(MAX_PROFILE_BYTES)
    .describe("Markdown to append, or the full new profile when mode is replace."),
};

export async function handleMyContextUpdate(args: {
  mode?: "append" | "replace" | undefined;
  content: string;
}): Promise<ToolResult> {
  const name = await resolveProfileName();
  const mode = args.mode ?? "append";
  const merge = (current: string) =>
    mode === "append" && current.trim()
      ? `${current.replace(/\s+$/, "")}\n\n${args.content}`
      : args.content;

  // The default profile may live in the vault: update the file there instead
  // of silently switching the profile back to inline mode.
  if (
    name === DEFAULT_PROFILE &&
    (await getDefaultProfileMode()) === "vault" &&
    vaultConfigured()
  ) {
    const cfg = await getInstanceConfigAsync();
    const path = cfg.contextPath || "System/context.md";
    const { vaultRead, vaultWrite } = await import("@/connectors/vault/lib/github");
    let current = "";
    let sha: string | undefined;
    try {
      const file = await vaultRead(path);
      current = file.content;
      sha = file.sha;
    } catch (err) {
      if (!/not found/i.test(toMsg(err))) throw err;
    }
    const next = merge(current);
    if (new TextEncoder().encode(next).length > MAX_PROFILE_BYTES) {
      return profileError(new ProfileError("Profile too large.", "too_large"));
    }
    await vaultWrite(path, next, "Update profile (my_context_update)", sha);
    return text(`Updated the profile file "${path}" in the vault (${mode}).`);
  }

  const next = merge((await getProfileContent(name)) ?? "");
  try {
    await saveProfile(name, next);
  } catch (err) {
    if (err instanceof ProfileError) return profileError(err);
    throw err;
  }
  const where = name === DEFAULT_PROFILE ? "the default profile" : `profile "${name}"`;
  return text(`Updated ${where} (${mode}, ${next.length} characters).`);
}

function profileError(err: ProfileError): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: err.code, message: err.message }) }],
    isError: true,
  };
}
