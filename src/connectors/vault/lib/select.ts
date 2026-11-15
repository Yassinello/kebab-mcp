/**
 * VLT-04 (Kebab House phase 2): which vault backend serves this request.
 *
 *   1. `KEBAB_VAULT_BACKEND=github|kv` forces a backend (explicit choice —
 *      e.g. `kv` after importing a GitHub vault, to stop using GitHub
 *      without deleting the credentials).
 *   2. Otherwise `github` when both `GITHUB_PAT` and `GITHUB_REPO` are set
 *      (existing instances keep their vault, unchanged);
 *   3. otherwise `kv` — the vault lives in the instance's KV store.
 *
 * Resolved on every call (not cached): credentials saved from the dashboard
 * arrive through the request context, and an operator switching the env var
 * expects the next call to follow.
 */
import { getConfig } from "@/core/config-facade";
import type { VaultBackend, VaultBackendKind } from "./backend";
import { githubVaultBackend } from "./github-backend";
import { kvVaultBackend } from "./kv-backend";

export interface VaultBackendChoice {
  kind: VaultBackendKind;
  /** Why this backend: forced by the env var, or detected from credentials. */
  reason: "forced" | "github-credentials" | "default";
  githubConfigured: boolean;
}

export function githubVaultConfigured(): boolean {
  return Boolean(getConfig("GITHUB_PAT") && getConfig("GITHUB_REPO"));
}

const warnedInvalid = new Set<string>();

export function resolveVaultBackendKind(): VaultBackendChoice {
  const githubConfigured = githubVaultConfigured();
  const forced = (getConfig("KEBAB_VAULT_BACKEND") ?? "").trim().toLowerCase();
  if (forced === "github" || forced === "kv") {
    return { kind: forced, reason: "forced", githubConfigured };
  }
  if (forced && !warnedInvalid.has(forced)) {
    warnedInvalid.add(forced);
    console.warn(
      `[Kebab MCP] KEBAB_VAULT_BACKEND="${forced}" is not "github" or "kv" — ignored (auto-detect).`
    );
  }
  return githubConfigured
    ? { kind: "github", reason: "github-credentials", githubConfigured }
    : { kind: "kv", reason: "default", githubConfigured };
}

export function getVaultBackend(): VaultBackend {
  return resolveVaultBackendKind().kind === "github" ? githubVaultBackend : kvVaultBackend;
}
