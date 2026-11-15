/**
 * Phase 50 / MCP-01 — vault MCP resource provider.
 *
 * Exposes every `.md` note of the vault as an MCP resource, whatever the
 * backend (Kebab House phase 2: GitHub repository or KV store). URI scheme:
 * `vault://<path>` where `<path>` is the note path relative to the vault
 * root.
 *
 * Pilot provider for the `resources/*` capability. See
 * `src/core/resources.ts` for the registry wiring.
 */

import type { ResourceProvider, ResourceSpec, ResourceContent } from "@/core/resources";
import { ResourceDispatchError } from "@/core/resources";
import { validateVaultPath } from "./lib/paths";
import { getVaultBackend } from "./lib/select";

const SCHEME = "vault";
const URI_PREFIX = `${SCHEME}://`;

function uriFor(path: string): string {
  // Normalize separators; strip any leading ./ — vault paths never start
  // with a slash.
  const clean = path.replace(/^\.\//, "");
  return `${URI_PREFIX}${clean}`;
}

function pathFromUri(uri: string): string {
  if (!uri.startsWith(URI_PREFIX)) {
    throw new ResourceDispatchError(`expected vault:// URI, got: ${uri}`, "invalid_uri");
  }
  return uri.slice(URI_PREFIX.length);
}

export const vaultResources: ResourceProvider = {
  scheme: SCHEME,

  async list(): Promise<ResourceSpec[]> {
    const tree = await getVaultBackend().tree();
    return tree
      .filter((f) => f.path.endsWith(".md"))
      .map((f) => ({
        uri: uriFor(f.path),
        name: f.path,
        description: `Vault note — ${f.path}`,
        mimeType: "text/markdown",
      }));
  },

  async read(uri: string): Promise<ResourceContent> {
    const path = pathFromUri(uri);
    // validateVaultPath covers null-bytes, absolute, and `..` traversal
    // (matches the guard on tool handlers).
    try {
      validateVaultPath(path);
    } catch (err) {
      throw new ResourceDispatchError(
        `invalid vault path: ${(err as Error).message}`,
        "invalid_uri"
      );
    }
    // Only .md — the vault is Markdown-shaped; binary files require a tool.
    if (!path.endsWith(".md")) {
      throw new ResourceDispatchError(
        `vault resource must end in .md: ${path}`,
        "unsupported_extension"
      );
    }
    const file = await getVaultBackend().read(path);
    return {
      uri,
      mimeType: "text/markdown",
      text: file.content,
    };
  },
};
