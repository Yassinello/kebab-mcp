import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "MyMCP — Dashboard",
  description: "Personal MCP Server Dashboard",
};

/**
 * Root layout — reads the per-request CSP nonce minted in `proxy.ts`
 * (middleware) via the forwarded `x-nonce` request header and makes it
 * available for server components that render `<Script nonce=…>`.
 *
 * Next 16's server runtime automatically propagates the nonce to its
 * own bootstrap / RSC flight payload inline scripts once `headers()`
 * has been consumed in a layout — this is the documented activation
 * pattern. Without this read, the CSP `'strict-dynamic' 'nonce-…'`
 * directive in production blocks Next's inline bootstrap scripts and
 * the dashboard fails to hydrate.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Consume x-nonce so Next 16 treats this route as nonce-aware. The
  // value is not passed to <html>/<body> directly — Next applies it to
  // its own inline scripts once the layout has read it.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  void nonce;

  return (
    <html lang="en">
      <body className="bg-bg text-text antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
