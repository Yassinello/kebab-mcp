import { NextResponse } from "next/server";
import { execSync } from "node:child_process";
import { checkAdminAuth } from "@/core/auth";

/**
 * GET  /api/config/update → check if updates are available
 *                           { available: boolean, behind: number, remote: string, latest?: string, disabled?: string }
 * POST /api/config/update → fast-forward merge from the update remote
 *                           { ok: boolean, pulled?: number, reason?: string }
 *
 * The update remote is `upstream` if present, else `origin`. Disabled on Vercel
 * and when MYMCP_DISABLE_UPDATE_API=1 is set.
 */

function run(cmd: string): { ok: boolean; out: string; err: string } {
  try {
    const out = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }).trim();
    return { ok: true, out, err: "" };
  } catch (err) {
    const e = err as { message?: string; stderr?: Buffer | string };
    const stderr = e.stderr ? e.stderr.toString().trim() : "";
    return { ok: false, out: "", err: stderr || e.message || String(err) };
  }
}

function disabledReason(): string | null {
  if (process.env.VERCEL === "1") return "Disabled on Vercel — redeploy via git push instead.";
  if (process.env.MYMCP_DISABLE_UPDATE_API === "1") return "Disabled via MYMCP_DISABLE_UPDATE_API.";
  return null;
}

function resolveRemote(): { ok: true; remote: string } | { ok: false; error: string } {
  const inside = run("git rev-parse --is-inside-work-tree");
  if (!inside.ok || inside.out !== "true") {
    return { ok: false, error: "Not a git work tree." };
  }
  const remotes = run("git remote");
  if (!remotes.ok) return { ok: false, error: "git remote failed." };
  const list = remotes.out.split(/\s+/).filter(Boolean);
  if (list.includes("upstream")) return { ok: true, remote: "upstream" };
  if (list.includes("origin")) return { ok: true, remote: "origin" };
  return { ok: false, error: "No upstream or origin remote configured." };
}

export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  const disabled = disabledReason();
  if (disabled) {
    return NextResponse.json({ available: false, behind: 0, remote: "", disabled });
  }

  const remoteRes = resolveRemote();
  if (!remoteRes.ok) {
    return NextResponse.json({
      available: false,
      behind: 0,
      remote: "",
      disabled: remoteRes.error,
    });
  }
  const { remote } = remoteRes;

  const fetch = run(`git fetch ${remote} main --quiet`);
  if (!fetch.ok) {
    return NextResponse.json({
      available: false,
      behind: 0,
      remote,
      disabled: `git fetch ${remote} failed: ${fetch.err.split("\n")[0]}`,
    });
  }

  const behind = run(`git rev-list --count HEAD..${remote}/main`);
  const ahead = run(`git rev-list --count ${remote}/main..HEAD`);
  const latest = run(`git rev-parse ${remote}/main`);

  const behindCount = behind.ok ? Number(behind.out) : 0;
  const aheadCount = ahead.ok ? Number(ahead.out) : 0;

  return NextResponse.json({
    available: behindCount > 0,
    behind: behindCount,
    ahead: aheadCount,
    remote,
    latest: latest.ok ? latest.out.slice(0, 7) : null,
  });
}

export async function POST(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  const disabled = disabledReason();
  if (disabled) return NextResponse.json({ ok: false, reason: disabled }, { status: 403 });

  const remoteRes = resolveRemote();
  if (!remoteRes.ok) {
    return NextResponse.json({ ok: false, reason: remoteRes.error }, { status: 400 });
  }
  const { remote } = remoteRes;

  // Refuse if local has uncommitted changes or diverged commits
  const status = run("git status --porcelain");
  if (status.ok && status.out.length > 0) {
    return NextResponse.json(
      { ok: false, reason: "Uncommitted local changes — commit or stash first." },
      { status: 409 }
    );
  }

  const fetch = run(`git fetch ${remote} main --quiet`);
  if (!fetch.ok) {
    return NextResponse.json(
      { ok: false, reason: `git fetch failed: ${fetch.err.split("\n")[0]}` },
      { status: 502 }
    );
  }

  const ahead = run(`git rev-list --count ${remote}/main..HEAD`);
  if (ahead.ok && Number(ahead.out) > 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: `${ahead.out} local commits ahead of ${remote}/main — resolve manually with 'git merge ${remote}/main'.`,
      },
      { status: 409 }
    );
  }

  const behind = run(`git rev-list --count HEAD..${remote}/main`);
  const pulled = behind.ok ? Number(behind.out) : 0;

  if (pulled === 0) {
    return NextResponse.json({ ok: true, pulled: 0, reason: "Already up to date." });
  }

  const merge = run(`git merge --ff-only ${remote}/main`);
  if (!merge.ok) {
    return NextResponse.json(
      { ok: false, reason: `Merge failed: ${merge.err.split("\n")[0]}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    pulled,
    remote,
    note: "Merged. Restart the dev server to load new code (Next.js auto-reloads most changes).",
  });
}
