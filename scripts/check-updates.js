#!/usr/bin/env node
/**
 * Pre-dev auto-update hook.
 *
 * Silently fast-forwards the working copy to the latest upstream `main`
 * before `next dev` starts. Runs on `npm run dev` via the `predev` script
 * in package.json.
 *
 * Behavior:
 * - Detects the update remote: prefers `upstream`, falls back to `origin`
 * - Skips entirely on CI / Vercel / prod / non-git environments
 * - Fetches, compares SHAs, fast-forwards only if behind
 * - Aborts (with a clear message) if a conflict would occur, never rewrites local work
 * - Prints a concise summary: "up to date", "pulled N commits", or "conflict"
 *
 * Exit code is always 0 so `next dev` still starts even if the update check fails.
 */

const { execSync } = require("node:child_process");

const SKIP = ["1", "true", "yes"];
function skipRequested() {
  if (process.env.CI && SKIP.includes(String(process.env.CI).toLowerCase())) return "CI";
  if (process.env.VERCEL === "1") return "Vercel";
  if (process.env.MYMCP_SKIP_UPDATE_CHECK) return "MYMCP_SKIP_UPDATE_CHECK";
  return null;
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

function tryRun(cmd) {
  try {
    return { ok: true, out: run(cmd) };
  } catch (err) {
    return { ok: false, out: "", err: err instanceof Error ? err.message : String(err) };
  }
}

function log(msg) {
  process.stdout.write(`\x1b[2m[mymcp update]\x1b[0m ${msg}\n`);
}

function warn(msg) {
  process.stdout.write(`\x1b[33m[mymcp update]\x1b[0m ${msg}\n`);
}

async function main() {
  const skipReason = skipRequested();
  if (skipReason) {
    log(`skipped (${skipReason})`);
    return;
  }

  // Must be inside a git work tree
  const inside = tryRun("git rev-parse --is-inside-work-tree");
  if (!inside.ok || inside.out !== "true") {
    log("skipped (not a git work tree)");
    return;
  }

  // Pick the remote: upstream if present, else origin
  const remotes = tryRun("git remote");
  if (!remotes.ok) {
    log("skipped (no git remotes available)");
    return;
  }
  const remoteList = remotes.out.split(/\s+/).filter(Boolean);
  const remote = remoteList.includes("upstream")
    ? "upstream"
    : remoteList.includes("origin")
      ? "origin"
      : null;
  if (!remote) {
    log("skipped (no upstream or origin remote)");
    return;
  }

  // Refuse to touch working copy if there are uncommitted changes
  const status = tryRun("git status --porcelain");
  if (!status.ok) {
    log("skipped (git status failed)");
    return;
  }
  const hasLocalChanges = status.out.length > 0;

  // Fetch quietly
  const fetch = tryRun(`git fetch ${remote} main --quiet`);
  if (!fetch.ok) {
    // Network errors are non-fatal — just skip
    log(`skipped (fetch ${remote} failed: ${fetch.err.split("\n")[0]})`);
    return;
  }

  const local = tryRun("git rev-parse HEAD");
  const upstream = tryRun(`git rev-parse ${remote}/main`);
  if (!local.ok || !upstream.ok) {
    log("skipped (unable to resolve refs)");
    return;
  }

  if (local.out === upstream.out) {
    log("up to date");
    return;
  }

  // Count commits behind
  const behind = tryRun(`git rev-list --count HEAD..${remote}/main`);
  const behindCount = behind.ok ? behind.out : "?";

  // Any local commits ahead? If yes, abort — don't rewrite the user's work
  const ahead = tryRun(`git rev-list --count ${remote}/main..HEAD`);
  if (ahead.ok && Number(ahead.out) > 0) {
    warn(
      `${behindCount} commits behind ${remote}/main, but ${ahead.out} local commits — skipping (run 'git merge ${remote}/main' manually)`
    );
    return;
  }

  if (hasLocalChanges) {
    warn(
      `${behindCount} commits behind ${remote}/main, but uncommitted changes — skipping (commit/stash, then rerun 'npm run dev')`
    );
    return;
  }

  // Fast-forward
  const merge = tryRun(`git merge --ff-only ${remote}/main`);
  if (!merge.ok) {
    warn(`${behindCount} behind but merge failed: ${merge.err.split("\n")[0]}`);
    return;
  }

  log(`pulled ${behindCount} commit${behindCount === "1" ? "" : "s"} from ${remote}/main`);
}

main().catch((err) => {
  warn(`update check failed: ${err instanceof Error ? err.message : String(err)}`);
  // Never block dev start
  process.exit(0);
});
