/**
 * Contract test: package-lock.json MUST contain Linux-x64 native binaries
 * for the build toolchain.
 *
 * Why this exists (2026-04-29):
 *   v0.16 hit a CI rabbit-hole because npm on Windows omits foreign-platform
 *   `optionalDependencies` from the lockfile by default. When a contributor
 *   runs `npm install` on Windows and commits the regenerated lock, CI on
 *   Ubuntu fails with:
 *     "Cannot find module ../lightningcss.linux-x64-gnu.node"
 *     "Cannot find module @tailwindcss/oxide-linux-x64-gnu"
 *     "Cannot find module @next/swc-linux-x64-gnu"
 *
 *   The previous workaround was to add these as explicit top-level
 *   `optionalDependencies` in package.json. Those pins went stale (swc
 *   16.2.4 while next was on 16.4.x) and were removed in 2026-11 once the
 *   lock was regenerated on Linux. This test now checks what actually
 *   matters: for each parent package (next, @tailwindcss/oxide,
 *   lightningcss) the lockfile resolves the linux-x64-gnu binary the parent
 *   declares — hoisted (node_modules/<bin>) or nested under the parent
 *   (node_modules/<parent>/node_modules/<bin>) — at the exact version the
 *   parent asks for.
 *
 *   To regenerate the lock with all platforms in scope (recommended after
 *   bumping next/tailwind/lightningcss):
 *     - On Linux/macOS:  `npm install --package-lock-only`
 *     - On Windows:      `bash scripts/regen-lock-linux.sh` (uses Docker)
 *
 *   Bypass: if you genuinely need to drop a binary (e.g. the project no
 *   longer builds with Tailwind), update REQUIRED_BINARIES below and
 *   document why.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** [parent package, linux-x64-gnu binary it declares as optionalDependency] */
const REQUIRED_BINARIES: Array<[parent: string, bin: string]> = [
  ["lightningcss", "lightningcss-linux-x64-gnu"],
  ["next", "@next/swc-linux-x64-gnu"],
  ["@tailwindcss/oxide", "@tailwindcss/oxide-linux-x64-gnu"],
];

type LockEntry = {
  version?: string;
  os?: string[];
  optionalDependencies?: Record<string, string>;
};

describe("contract: package-lock.json includes Linux-x64 native binaries", () => {
  const lockPath = join(process.cwd(), "package-lock.json");
  const lockText = readFileSync(lockPath, "utf8");
  const lock = JSON.parse(lockText) as { packages?: Record<string, LockEntry> };
  const packages = lock.packages ?? {};

  for (const [parent, bin] of REQUIRED_BINARIES) {
    it(`resolves ${bin} for ${parent}`, () => {
      const parentKey = `node_modules/${parent}`;
      const parentEntry = packages[parentKey];
      expect(parentEntry, `${parentKey} missing from package-lock.json`).toBeDefined();
      const wanted = parentEntry?.optionalDependencies?.[bin];
      expect(wanted, `${parent} no longer declares ${bin} — update REQUIRED_BINARIES`).toBeTruthy();

      // Node resolution from the parent: nested first, then hoisted.
      const nestedKey = `${parentKey}/node_modules/${bin}`;
      const hoistedKey = `node_modules/${bin}`;
      const key = packages[nestedKey] ? nestedKey : hoistedKey;
      const entry = packages[key];
      expect(
        entry,
        `package-lock.json resolves no "${bin}" for ${parent} (looked at ${nestedKey} and ` +
          `${hoistedKey}). This means \`npm ci\` on Linux will fail to install the native ` +
          `binary, and CI will error with "Cannot find module".\n\n` +
          `Fix: regenerate the lock with all platforms in scope.\n` +
          `  - On Linux/macOS:  npm install --package-lock-only\n` +
          `  - On Windows:      bash scripts/regen-lock-linux.sh (Docker required)\n\n` +
          `Then commit the updated package-lock.json.`
      ).toBeDefined();
      expect(entry?.version, `${key} is ${entry?.version}, ${parent} wants ${wanted}`).toBe(wanted);
    });
  }
});
