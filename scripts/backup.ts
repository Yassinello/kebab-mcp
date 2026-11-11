#!/usr/bin/env npx tsx
/**
 * Kebab MCP Backup CLI — export / import KV store data.
 *
 * Usage:
 *   npx tsx scripts/backup.ts export [--scope=all] [--no-secrets]
 *   npx tsx scripts/backup.ts import backup.json [--mode=merge|replace] [--scope=all]
 *
 * SEC-02 (2026-11): the CLI is the operator path (it already holds the raw
 * KV credentials), so exports include secret-bearing keys by default —
 * pass --no-secrets for a shareable redacted export. The MCP tools never
 * include secrets. Treat full exports as credentials.
 *
 * Phase 42 (TEN-04) — default scope is the current tenant. The CLI
 * runs outside any HTTP request context, so there is no tenant
 * header; the null-tenant (default / single-tenant) path is used
 * unless `--scope=all` opts into the full cross-tenant export.
 */

import { promises as fs } from "node:fs";

// Shared logic is extracted so admin tools can reuse it.
import { exportBackup, importBackup, BACKUP_VERSION } from "../src/core/backup";

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "export") {
    let scope: "tenant" | "all" = "tenant";
    for (const arg of rest) {
      if (arg === "--scope=all") scope = "all";
      else if (arg === "--scope=tenant") scope = "tenant";
    }
    const data = await exportBackup({
      scope,
      includeSecrets: !process.argv.includes("--no-secrets"),
    });
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    process.exit(0);
  }

  if (command === "import") {
    // Parse optional --mode=replace|merge and --scope=all flags
    let filePath: string | undefined;
    let mode: "merge" | "replace" = "merge";
    let scope: "tenant" | "all" = "tenant";
    for (const arg of rest) {
      if (arg.startsWith("--mode=")) {
        const val = arg.slice(7);
        if (val === "replace" || val === "merge") mode = val;
        else {
          console.error(`Invalid mode: ${val}. Use "merge" or "replace".`);
          process.exit(1);
        }
      } else if (arg === "--scope=all") {
        scope = "all";
      } else if (arg === "--scope=tenant") {
        scope = "tenant";
      } else {
        filePath = arg;
      }
    }
    if (!filePath) {
      console.error(
        "Usage: npx tsx scripts/backup.ts import <file.json> [--mode=merge|replace] [--scope=all]"
      );
      process.exit(1);
    }
    const raw = await fs.readFile(filePath, "utf-8");
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error("Error: invalid JSON in", filePath);
      process.exit(1);
    }
    const result = await importBackup(data, { mode, scope, includeSecrets: true });
    console.log(result.message);
    process.exit(result.ok ? 0 : 1);
  }

  console.error(`Unknown command: ${command}`);
  console.error(
    "Usage: npx tsx scripts/backup.ts <export|import> [file] [--mode=merge|replace] [--scope=all]"
  );
  console.error(`Backup format version: ${BACKUP_VERSION}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
