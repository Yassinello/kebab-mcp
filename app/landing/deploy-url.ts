/**
 * Shared Vercel "Deploy to Vercel" URL for the Kebab MCP template.
 *
 * We pre-attach Upstash Redis via Vercel's `stores` query param so the
 * one-click deploy provisions durable storage alongside the project,
 * instead of leaving the user to install the integration separately
 * after the fact. Without pre-attachment, fresh deploys land on
 * serverless `/tmp` and silently lose all welcome-flow state on the
 * first cold-start (~15 min) — the bug that motivated the v4 welcome
 * refactor.
 *
 * Spec: https://vercel.com/docs/deployments/deploy-button
 * Integration slug: `upstash` · product slug: `upstash-kv` (KV / Redis).
 */
export const REPO_URL = "https://github.com/Yassinello/kebab-mcp";

const STORES = [
  {
    type: "integration",
    integrationSlug: "upstash",
    productSlug: "upstash-kv",
  },
];

export const VERCEL_DEPLOY_URL =
  "https://vercel.com/new/clone?" +
  new URLSearchParams({
    "repository-url": REPO_URL,
    "project-name": "kebab-mcp",
    stores: JSON.stringify(STORES),
  }).toString();
