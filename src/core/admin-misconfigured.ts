/**
 * 2026-11 audit (C1.7) — the SEC-A-03 misconfiguration response, in a
 * dependency-free module so proxy.ts can serve the same friendly page as
 * the route-level admin check without pulling auth.ts into its bundle.
 */
/** Machine-readable text of the SEC-A-03 misconfiguration (kept stable for API clients). */
export const ADMIN_MISCONFIGURED_MESSAGE =
  "Admin auth misconfigured: ADMIN_AUTH_TOKEN is required when MCP_AUTH_TOKEN is set " +
  "(or set KEBAB_ADMIN_TOKEN_FALLBACK=1 to allow shared-token fallback).";

export const ADMIN_MISCONFIGURED_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>One setting is missing</title>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #fafafa; color: #111827; line-height: 1.55; }
  main { max-width: 36rem; margin: 10vh auto; padding: 2rem; background: #fff;
    border: 1px solid #e5e7eb; border-radius: 12px; }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
  p, li { color: #374151; }
  code, pre { font-family: "SF Mono", "Fira Code", Consolas, monospace; font-size: .9em; }
  pre { background: #f3f4f6; border-radius: 8px; padding: .75rem 1rem; overflow-x: auto; color: #111827; }
  .muted { color: #4b5563; font-size: .9rem; }
</style>
</head>
<body>
<main>
  <h1>Your dashboard needs its own key</h1>
  <p>This server has a key for AI clients (<code>MCP_AUTH_TOKEN</code>) but no separate key for
  the dashboard. For your safety, the dashboard stays closed until you choose one of these:</p>
  <ol>
    <li><strong>Recommended:</strong> add a dashboard key, a long random value different from the
    AI client key:
    <pre>ADMIN_AUTH_TOKEN=a-long-random-value</pre></li>
    <li>Or, to keep using one key for everything (less safe), add:
    <pre>KEBAB_ADMIN_TOKEN_FALLBACK=1</pre></li>
  </ol>
  <p><strong>Where:</strong> in the environment of the server. With Docker, put the line in your
  <code>.env</code> file (or under <code>environment:</code> in <code>docker-compose.yml</code>),
  then restart the container. On Vercel: Project Settings &rarr; Environment Variables, then
  redeploy.</p>
  <p class="muted">Then open this page again and sign in with the dashboard key.</p>
</main>
</body>
</html>
`;

/**
 * 2026-11 audit (C1.7): response for the SEC-A-03 misconfiguration
 * (production, MCP_AUTH_TOKEN set, no ADMIN_AUTH_TOKEN, no opt-in).
 * Browsers (Accept: text/html) get a short page that says what to set and
 * where; API clients keep a machine-readable JSON body. Status 503 either way.
 */
export function adminMisconfiguredResponse(request: Request): Response {
  const accept = request.headers.get("accept") ?? "";
  const headers = { "Cache-Control": "no-store" };
  if (/\btext\/html\b/i.test(accept)) {
    return new Response(ADMIN_MISCONFIGURED_HTML, {
      status: 503,
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response(
    JSON.stringify({ error: "admin_auth_misconfigured", message: ADMIN_MISCONFIGURED_MESSAGE }),
    { status: 503, headers: { ...headers, "Content-Type": "application/json" } }
  );
}
