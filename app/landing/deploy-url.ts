/**
 * Deploy-flow URLs for Kebab House (repo: Yassinello/kebab-mcp).
 *
 * Recommended path: the **Vercel Deploy Button** (`/new/clone`). One link
 * creates a copy of the repo in the user's GitHub account, a Vercel
 * project, and a free Upstash Redis database (the `stores` parameter),
 * then deploys. The user lands on `/welcome` of their new instance.
 *
 * History, short: the button was dropped in April 2026 because the copy
 * it creates is not a GitHub fork (no `parent`), and the dashboard's only
 * update path was `merge-upstream`, which rejects non-forks — clone users
 * could never update (kebab-mcp-yass instance, 2026-04-28). A
 * `/new/deploy` variant pointing Vercel at upstream was tried next and
 * dropped too (no signposting, unverifiable redeploys for non-owners).
 * Fork + Import became the only path.
 *
 * Why the button is fine again: phase 2 added **release sync**
 * (src/core/release-sync.ts). For a repo that is not a fork, the
 * dashboard's *Update now* copies the files of the latest upstream release
 * into the user's repo as one commit, after checking that none of those
 * files were edited locally. Forks keep `merge-upstream`, unchanged.
 *
 * Fork + Import stays documented on /deploy as the alternative for people
 * who want a real fork (GitHub's *Sync fork* button, git history shared
 * with upstream).
 *
 * Not done: `redirect-url` (send the user back to their instance after the
 * deploy) needs a registered Vercel integration — see docs/HOSTING.md.
 *
 * Spec: https://vercel.com/docs/deploy-button
 * Upstash: integration slug `upstash`, product slug `upstash-kv`.
 */
export const REPO_URL = "https://github.com/Yassinello/kebab-mcp";

export const UPSTREAM_OWNER = REPO_URL.split("/").at(-2)!; // "Yassinello"
export const UPSTREAM_REPO_SLUG = REPO_URL.split("/").at(-1)!; // "kebab-mcp"

/**
 * Vercel Deploy Button (recommended path). `stores` attaches a free
 * Upstash Redis database during the deploy, so KV is there on first boot
 * (the auth token and saved credentials survive cold starts).
 */
const VERCEL_DEPLOY_BUTTON_STORES = [
  { type: "integration", integrationSlug: "upstash", productSlug: "upstash-kv" },
] as const;

export const VERCEL_DEPLOY_BUTTON_URL =
  "https://vercel.com/new/clone?" +
  [
    `repository-url=${encodeURIComponent(REPO_URL)}`,
    "project-name=kebab-house",
    "repository-name=kebab-house",
    `stores=${encodeURIComponent(JSON.stringify(VERCEL_DEPLOY_BUTTON_STORES))}`,
  ].join("&");

/**
 * Alternative flow, step 1: fork upstream into the user's
 * GitHub account. GitHub's `/fork` URL opens the "Create a new fork"
 * dialog with the source repo pre-selected.
 */
export const GITHUB_FORK_URL = `${REPO_URL}/fork`;

/**
 * Alternative flow, step 2: import the user's freshly-
 * created fork into Vercel. The /new screen lists the user's GitHub
 * repos with an "Import" button; the fork shows up there.
 *
 * No query params on this URL — Vercel doesn't accept a `repository-url`
 * pre-fill on the manual import flow (that's only the Deploy Button
 * variant above). Users pick their fork
 * from the list. The /deploy page walks them through it visually.
 */
export const VERCEL_IMPORT_URL = "https://vercel.com/new";
