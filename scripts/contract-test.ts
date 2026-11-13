/**
 * Contract snapshot test for Kebab MCP.
 * Verifies that tool names and input schemas haven't changed unexpectedly.
 *
 * Run: npx tsx scripts/contract-test.ts
 *
 * On first run: creates scripts/contract-snapshot.json
 * On subsequent runs: compares current state to snapshot, fails on drift
 * To update snapshot after intentional changes: delete the snapshot file and re-run
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// Derive the connector list from the same source as the runtime registry.
// Previously this file maintained its own list and three connectors (composio,
// skills, airtable) silently drifted out of test coverage. Importing the
// source of truth directly closes that gap.
//
// PERF-01: post-v0.11 Phase 43, connector manifests load lazily via the
// `ALL_CONNECTOR_LOADERS` table — the old `ALL_CONNECTORS` array is gone.
// The contract test INTENTIONALLY loads every manifest (that's what the
// contract test measures). One-time CI cost, not a request-time cost.
import { ALL_CONNECTOR_LOADERS } from "../src/core/registry";
import type { ConnectorManifest } from "../src/core/types";
import { toolAnnotations, type KebabToolAnnotations } from "../src/core/tool-annotations";
const SNAPSHOT_PATH = resolve(__dirname, "contract-snapshot.json");

interface ToolContract {
  name: string;
  pack: string;
  schemaKeys: string[];
  destructive: boolean;
  /** TRU-01: the MCP annotations (incl. title) published in tools/list. */
  annotations: KebabToolAnnotations;
}

async function loadAllManifests(): Promise<ConnectorManifest[]> {
  return Promise.all(ALL_CONNECTOR_LOADERS.map((entry) => entry.loader()));
}

async function getCurrentContract(): Promise<{
  contract: ToolContract[];
  manifests: ConnectorManifest[];
}> {
  const manifests = await loadAllManifests();
  const contract = manifests
    .flatMap((pack) =>
      pack.tools.map((tool) => ({
        name: tool.name,
        pack: pack.id,
        schemaKeys: Object.keys(tool.schema).sort(),
        destructive: tool.destructive,
        annotations: toolAnnotations(tool, pack),
      }))
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return { contract, manifests };
}

async function main() {
  const { contract: current, manifests } = await getCurrentContract();

  console.log(
    `[Contract Test] Found ${current.length} tools across ${manifests.length} connectors\n`
  );

  // Print summary
  for (const pack of manifests) {
    console.log(`  ${pack.label}: ${pack.tools.length} tools`);
  }
  console.log();

  if (!existsSync(SNAPSHOT_PATH)) {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2));
    console.log(`[Contract Test] Snapshot created at ${SNAPSHOT_PATH}`);
    console.log("[Contract Test] PASS (first run — baseline established)");
    process.exit(0);
  }

  const snapshot: ToolContract[] = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8"));

  // Compare
  let failures = 0;

  // Check for removed tools
  for (const snap of snapshot) {
    const found = current.find((c) => c.name === snap.name);
    if (!found) {
      console.error(`  REMOVED: ${snap.name} (was in ${snap.pack})`);
      failures++;
    }
  }

  // Check for added tools
  for (const cur of current) {
    const found = snapshot.find((s) => s.name === cur.name);
    if (!found) {
      console.error(`  ADDED: ${cur.name} (in ${cur.pack})`);
      failures++;
    }
  }

  // Check for schema changes
  for (const cur of current) {
    const snap = snapshot.find((s) => s.name === cur.name);
    if (!snap) continue;

    const curKeys = JSON.stringify(cur.schemaKeys);
    const snapKeys = JSON.stringify(snap.schemaKeys);

    if (curKeys !== snapKeys) {
      console.error(
        `  CHANGED: ${cur.name} schema — was [${snap.schemaKeys}] → now [${cur.schemaKeys}]`
      );
      failures++;
    }

    if (cur.pack !== snap.pack) {
      console.error(`  MOVED: ${cur.name} — was in ${snap.pack} → now in ${cur.pack}`);
      failures++;
    }

    if (cur.destructive !== snap.destructive) {
      console.error(
        `  DESTRUCTIVE FLAG CHANGED: ${cur.name} — was ${snap.destructive} → now ${cur.destructive}`
      );
      failures++;
    }

    const curAnn = JSON.stringify(cur.annotations);
    const snapAnn = JSON.stringify(snap.annotations);
    if (curAnn !== snapAnn) {
      console.error(`  ANNOTATIONS CHANGED: ${cur.name} — was ${snapAnn} → now ${curAnn}`);
      failures++;
    }
  }

  if (failures > 0) {
    console.error(`\n[Contract Test] FAIL — ${failures} contract violation(s)`);
    console.error(
      "If these changes are intentional, delete scripts/contract-snapshot.json and re-run."
    );
    process.exit(1);
  }

  console.log("[Contract Test] PASS — all tool contracts match snapshot");
}

main().catch((err) => {
  console.error("[Contract Test] unhandled error:", err);
  process.exit(1);
});
