import { z } from "zod";
import type { ToolResult } from "@/core/types";
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
 *      profile is in vault mode — read through the vault backend interface
 *      (VLT-07), so it works on the GitHub and the KV backend alike;
 *   4. a short help message pointing at /config → Settings.
 */

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

const EMPTY_HELP =
  "No personal profile yet. Call kebab_setup to run the guided setup (a short interview, then a profile the user " +
  "validates, saved with my_context_update). The user can also write it in the Kebab House dashboard " +
  "(/config → Settings → Profile).";

/** The profile name this call should use (bound profile if it exists, else default). */
async function resolveProfileName(): Promise<string> {
  const bound = getCallerMeta()?.profile ?? null;
  if (bound && bound !== DEFAULT_PROFILE && (await profileExists(bound))) return bound;
  return DEFAULT_PROFILE;
}

/** Lazy import: the vault backends are only loaded for vault-mode profiles. */
async function vaultBackend() {
  const { getVaultBackend } = await import("@/connectors/vault/lib/select");
  return getVaultBackend();
}

async function defaultVaultPath(): Promise<string> {
  const cfg = await getInstanceConfigAsync();
  return cfg.contextPath || "System/context.md";
}

/** The profile served to the current caller, wherever it is stored. */
export interface ActiveProfile {
  /** Profile name (`default` or the hat bound to the caller's token). */
  name: string;
  /** `vault`: the default profile is a note in the vault; `inline`: stored in KV. */
  mode: "inline" | "vault";
  /** Markdown content; empty when there is no profile yet. */
  content: string;
  /** Vault path of the profile note (vault mode only). */
  path?: string;
  /** Vault mode: the note does not exist yet. */
  missing?: boolean;
}

/**
 * Resolve and read the caller's profile: the bound hat, else the default
 * profile — inline, or the vault note when the default is in vault mode.
 * The single source for my_context, kebab_setup and kebab_status, so a
 * vault-mode profile is never reported missing. Throws on a vault read
 * error other than "not found" (callers decide how to degrade).
 */
export async function readActiveProfile(): Promise<ActiveProfile> {
  const name = await resolveProfileName();
  if (name === DEFAULT_PROFILE && (await getDefaultProfileMode()) === "vault") {
    const path = await defaultVaultPath();
    try {
      const file = await (await vaultBackend()).read(path);
      return { name, mode: "vault", content: file.content, path };
    } catch (err) {
      if (/not found/i.test(toMsg(err))) {
        return { name, mode: "vault", content: "", path, missing: true };
      }
      throw err;
    }
  }
  return { name, mode: "inline", content: (await getProfileContent(name)) ?? "" };
}

export const myContextSchema = {};

export async function handleMyContext(): Promise<ToolResult> {
  const profile = await readActiveProfile();
  if (profile.mode === "vault") {
    if (profile.missing) {
      return text(
        `Profile file not found at "${profile.path}" in the vault. Create it, or switch the profile to inline in /config → Settings.`
      );
    }
    return text(profile.content);
  }
  if (!profile.content.trim()) return text(EMPTY_HELP);
  return text(
    profile.name !== DEFAULT_PROFILE
      ? `<!-- profile: ${profile.name} -->\n${profile.content}`
      : profile.content
  );
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
  if (name === DEFAULT_PROFILE && (await getDefaultProfileMode()) === "vault") {
    const path = await defaultVaultPath();
    const vault = await vaultBackend();
    let current = "";
    let sha: string | undefined;
    try {
      const file = await vault.read(path);
      current = file.content;
      sha = file.sha;
    } catch (err) {
      if (!/not found/i.test(toMsg(err))) throw err;
    }
    const next = merge(current);
    if (new TextEncoder().encode(next).length > MAX_PROFILE_BYTES) {
      return profileError(new ProfileError("Profile too large.", "too_large"));
    }
    await vault.write(path, next, {
      message: "Update profile (my_context_update)",
      expectedVersion: sha,
    });
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
