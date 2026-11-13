import type { Metadata } from "next";
import { redirect } from "next/navigation";
import LandingPage from "./landing/landing-page";
import { getConfig } from "@/core/config-facade";
import { PRODUCT } from "@/core/constants/brand";
import { isFirstRunMode, rehydrateBootstrapAsync } from "@/core/first-run";

export const dynamic = "force-dynamic";

const LANDING_TITLE = `${PRODUCT.name} — ${PRODUCT.tagline}`;
const LANDING_DESCRIPTION =
  "One skills library, one profile and one memory vault, shared by every AI client you use — Claude, Claude Code, Cursor, Codex, and ChatGPT (partial). A self-hosted hub, not an agent. Your Vercel, your keys, AGPL-3.0.";

export const metadata: Metadata = {
  title: LANDING_TITLE,
  description: LANDING_DESCRIPTION,
  openGraph: {
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    siteName: PRODUCT.name,
  },
};

export default async function HomePage() {
  // Routing rules for `/`:
  //   - Token present → user has finished setup → /config dashboard.
  //   - Explicit `INSTANCE_MODE=showcase` → marketing landing (e.g. the
  //     public mymcp-home demo).
  //   - Anything else (real deployments, including fresh forks) → /welcome
  //     to mint the token. The previous logic gated this on
  //     `INSTANCE_MODE=personal` being explicitly set, but Vercel's
  //     fork-then-import flow doesn't set any env vars, so first-time
  //     users landed on the marketing page on their own deploy.
  //     Default-to-welcome makes the zero-config path work.
  //
  // Local dev (`npm run dev`) without a token still hits /welcome, which
  // is the right behavior — the welcome page is what bootstraps state.
  // To preview the marketing landing locally, set INSTANCE_MODE=showcase.
  //
  // Cold-lambda note: on Vercel, the Node-side bootstrap cache is per-
  // process. A cold lambda whose Edge sibling has already warmed up
  // doesn't see the rehydrated token until rehydrateBootstrapAsync()
  // runs in this Node process. Without that, a freshly-minted token
  // living in KV would look "missing" here and we'd send the user back
  // to /welcome on every cold hit. The same pattern is used in
  // app/config/page.tsx — keep them in sync.
  await rehydrateBootstrapAsync();

  const mode = getConfig("INSTANCE_MODE");
  const isShowcase = mode === "showcase";

  if (isShowcase) {
    return <LandingPage />;
  }

  // hasToken is true when the boot env has MCP_AUTH_TOKEN OR the bootstrap
  // cache has been populated from KV. isFirstRunMode() encapsulates that
  // — invert it for the "user has set up" check.
  if (!isFirstRunMode()) {
    redirect("/config");
  }

  redirect("/welcome");
}
