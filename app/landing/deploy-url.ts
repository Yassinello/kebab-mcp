/**
 * Deploy-flow URLs for the Kebab MCP project.
 *
 * The recommended path is **Fork + Vercel Import**, NOT a one-click
 * Deploy Button. This is a deliberate choice grounded in two failures:
 *
 *   1. `https://vercel.com/new/clone?...` (the official Deploy Button)
 *      creates a new GitHub repo in the user's account by snapshotting
 *      upstream. The result is a STANDALONE repo: no `parent`, no
 *      shared history, no `merge-upstream` support. The dashboard's
 *      update flow is built on GitHub's Compare + merge-upstream APIs,
 *      which only behave correctly on real forks. Users get silently
 *      pinned to whatever snapshot they grabbed at deploy time and
 *      never see another release. We shipped this bug, hit it on the
 *      kebab-mcp-yass instance (2026-04-28), and reverted.
 *
 *   2. `https://vercel.com/new/deploy?...` was the next attempt. The
 *      idea was to point Vercel directly at upstream so every push
 *      redeploys the user's project. But the user lands on Vercel's
 *      generic "New Project" screen with no signposting, and we
 *      can't empirically verify (without testing on a third-party
 *      account) that pushes to a repo the user doesn't own actually
 *      trigger their Vercel webhooks. Possible-but-fragile is not
 *      good enough for a public open-source project.
 *
 * **Fork + Import** is slightly less magical (one extra click), but:
 *   - GitHub creates a real fork with `parent` set, so merge-upstream
 *     works out of the box.
 *   - The user owns their repo; Vercel's GitHub integration connects
 *     the user's own repo (no third-party-webhook ambiguity).
 *   - Pulling upstream releases is one click in the dashboard
 *     ("Update now") or one click on GitHub ("Sync fork").
 *   - The flow matches the rest of the open-source ecosystem.
 *
 * Constants below are intentionally split per role so future code
 * never accidentally reaches for a one-click URL again. If you find
 * yourself adding a `VERCEL_DEPLOY_URL` here, stop — re-read this
 * comment and the `/api/config/update` route to remember why.
 *
 * Upstash KV is recommended (auth token + saved credentials must
 * survive serverless cold starts), but it has to be added inside the
 * Vercel project after Import — there's no `stores` query param on
 * the manual import flow. The /deploy page walks users through this.
 *
 * Spec: https://vercel.com/docs/git
 * Integration slug: `upstash` · product slug: `upstash-kv` (KV / Redis).
 */
export const REPO_URL = "https://github.com/Yassinello/kebab-mcp";

export const UPSTREAM_OWNER = REPO_URL.split("/").at(-2)!; // "Yassinello"
export const UPSTREAM_REPO_SLUG = REPO_URL.split("/").at(-1)!; // "kebab-mcp"

/**
 * Step 1 of the recommended deploy flow: fork upstream into the user's
 * GitHub account. GitHub's `/fork` URL opens the "Create a new fork"
 * dialog with the source repo pre-selected.
 */
export const GITHUB_FORK_URL = `${REPO_URL}/fork`;

/**
 * Step 2 of the recommended deploy flow: import the user's freshly-
 * created fork into Vercel. The /new screen lists the user's GitHub
 * repos with an "Import" button; the fork shows up there.
 *
 * No query params on this URL — Vercel doesn't accept a `repository-url`
 * pre-fill on the manual import flow (that's only the Deploy Button
 * variant, which we are deliberately not using). Users pick their fork
 * from the list. The /deploy page walks them through it visually.
 */
export const VERCEL_IMPORT_URL = "https://vercel.com/new";
