/**
 * VLT-02 (Kebab House phase 2): the GitHub backend — the original GitHub
 * Contents/Trees/Commits code (`./github.ts`, unchanged) behind the
 * `VaultBackend` interface. Every method delegates to the same function the
 * tools used to call, with the same arguments, so tool outputs and GitHub
 * API traffic are identical to the pre-interface code.
 */
import { toMsg } from "@/core/error-utils";
import {
  checkVaultHealth,
  vaultDelete,
  vaultList,
  vaultRead,
  vaultRecentCommits,
  vaultSearch,
  vaultTree,
  vaultWrite,
} from "./github";
import { computeStats, type VaultBackend } from "./backend";

export const githubVaultBackend: VaultBackend = {
  kind: "github",

  read: (path) => vaultRead(path),

  write: (path, content, opts) => vaultWrite(path, content, opts?.message, opts?.expectedVersion),

  delete: (path, opts) => vaultDelete(path, opts?.message, opts?.expectedVersion),

  async move(from, to, opts) {
    if (from === to) throw new Error("Source and destination are the same path");
    // Same three steps vault_move always ran: read (content + SHA), write the
    // copy, delete the original with the known SHA (saves one GET).
    const source = await vaultRead(from);
    await vaultWrite(to, source.content, opts?.message);
    try {
      await vaultDelete(from, opts?.message, source.sha);
    } catch (error) {
      return { from, to, deleteError: toMsg(error) };
    }
    return { from, to };
  },

  list: (folder) => vaultList(folder),

  tree: (folder) => vaultTree(folder),

  search: (query, opts) => vaultSearch(query, opts.folder, opts.limit, opts.page),

  recent: (limit, opts) => vaultRecentCommits(limit, opts?.folder, opts?.since),

  async stats(folder) {
    return computeStats(await vaultTree(folder));
  },

  async health() {
    let h: Awaited<ReturnType<typeof checkVaultHealth>>;
    try {
      h = await checkVaultHealth();
    } catch (error) {
      return { ok: false, backend: "github", message: toMsg(error) };
    }
    return {
      ok: h.ok,
      backend: "github",
      message: h.ok ? "GitHub repository reachable" : `GitHub API error ${h.error ?? ""}`.trim(),
      details: { patValid: h.patValid, repoAccessible: h.repoAccessible, rateLimit: h.rateLimit },
    };
  },
};
