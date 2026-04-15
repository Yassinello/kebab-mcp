import type { NextConfig } from "next";

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

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
