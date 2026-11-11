import type { NextConfig } from "next";
import withBundleAnalyzer from "@next/bundle-analyzer";

const analyzeBundle = withBundleAnalyzer({ enabled: process.env.ANALYZE === "true" });

/**
 * Security headers applied to every response via next.config.
 *
 * Note: `Content-Security-Policy` is intentionally NOT set here. CSP now
 * lives in `proxy.ts` middleware so we can mint a per-request nonce and
 * drop `'unsafe-inline'` from `script-src` in production (SEC-01..04).
 * All other static security headers stay here.
 */

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // Legacy but cheap — modern browsers honor frame-ancestors in CSP,
  // older ones still read this.
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

/**
 * SEC-15 (2026-11 audit): HSTS for self-hosted (Docker) deployments — Vercel
 * already sets it on its edge. Two years + includeSubDomains, no preload
 * (preload is an operator decision tied to the domain).
 */
const HSTS_HEADER = {
  key: "Strict-Transport-Security",
  value: "max-age=63072000; includeSubDomains",
};

/**
 * SEC-15: responses of the admin/config APIs can carry secrets (env reveal,
 * .env export, tokens) — never let a browser or shared cache store them.
 */
const NO_STORE_HEADERS = [{ key: "Cache-Control", value: "no-store, max-age=0" }];

const nextConfig: NextConfig = {
  output: "standalone",

  experimental: {
    // PERF-04 (v0.11 Phase 43): prune unused exports from barrel packages.
    // Every tool schema imports `z` — without this, even tools that only
    // use `z.string()` drag the full zod runtime into the chunk.
    // `@opentelemetry/api` is imported across tracing.ts + logging.ts for
    // named exports; barrel-free resolution shaves ~5-10 KB per chunk.
    optimizePackageImports: ["zod", "@opentelemetry/api"],
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...SECURITY_HEADERS, HSTS_HEADER],
      },
      { source: "/api/config/:path*", headers: NO_STORE_HEADERS },
      { source: "/api/admin/:path*", headers: NO_STORE_HEADERS },
      { source: "/api/welcome/:path*", headers: NO_STORE_HEADERS },
      { source: "/api/auth/:path*", headers: NO_STORE_HEADERS },
    ];
  },
};

// Heaviest server chunks (Apr 2026): stagehand+browserbase (~2.3 MB),
// composio (~2.3 MB), zod (~280 KB). `serverExternalPackages` was
// evaluated in Phase 43 but tripled the `/api/[transport]` nft.json
// entries under Turbopack (417 → 1574) so it was NOT adopted; see
// 43-02-SUMMARY.md "PERF-03 deferred" for the specific measurement
// and the Turbopack tracing rationale. Revisit when Turbopack's
// `serverExternalPackages` trace-handling matures.
export default analyzeBundle(nextConfig);
