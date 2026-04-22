// BOOTSTRAP_EXEMPT: public OAuth redirect target; reads only deploy-time GOOGLE_CLIENT_ID/SECRET + VERCEL_URL, never bootstrap state or MCP_AUTH_TOKEN.
// PIPELINE_EXEMPT: public OAuth redirect receiver; no auth/rate-limit/tenant state to wire through the pipeline, and reply is a redirect not a JSON contract.
import { Google } from "arctic";
import { getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";

/**
 * Google OAuth callback — exchanges code for tokens.
 * Displays the refresh token for the user to copy to Vercel env vars.
 * Token is shown ONCE, never stored or logged by the server.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state parameter", { status: 400 });
  }

  // Retrieve state + verifier from cookie
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/mymcp_oauth=([^;]+)/);
  if (!match) {
    return new Response("OAuth session expired. Please try again.", {
      status: 400,
    });
  }

  let storedState: string;
  let codeVerifier: string;
  try {
    const parsed = JSON.parse(decodeURIComponent(match[1]));
    storedState = parsed.state;
    codeVerifier = parsed.codeVerifier;
  } catch {
    return new Response("Invalid OAuth session", { status: 400 });
  }

  if (state !== storedState) {
    return new Response("State mismatch — possible CSRF attack", {
      status: 400,
    });
  }

  const clientId = getConfig("GOOGLE_CLIENT_ID")!;
  const clientSecret = getConfig("GOOGLE_CLIENT_SECRET")!;
  const vercelUrl = getConfig("VERCEL_URL");
  const baseUrl = vercelUrl ? `https://${vercelUrl}` : "http://localhost:3000";

  const google = new Google(clientId, clientSecret, `${baseUrl}/api/auth/google/callback`);

  try {
    const tokens = await google.validateAuthorizationCode(code, codeVerifier);
    const refreshToken = tokens.refreshToken();

    if (!refreshToken) {
      return new Response(
        tokenPage(
          "No refresh token received. Make sure your OAuth app is configured with access_type=offline and prompt=consent.",
          null
        ),
        {
          status: 200,
          headers: {
            "Content-Type": "text/html",
            "Set-Cookie": "mymcp_oauth=; Path=/; HttpOnly; Max-Age=0",
          },
        }
      );
    }

    // Clear the OAuth cookie
    return new Response(tokenPage(null, refreshToken), {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Set-Cookie": "mymcp_oauth=; Path=/; HttpOnly; Max-Age=0",
      },
    });
  } catch (err) {
    const msg = toMsg(err);
    return new Response(tokenPage(`OAuth error: ${msg}`, null), {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function tokenPage(error: string | null, token: string | null): string {
  const safeToken = token ? escapeHtml(token) : null;
  const safeError = error ? escapeHtml(error) : null;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Kebab MCP — Google OAuth</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #141414; border: 1px solid #2a2a2a; border-radius: 12px; padding: 2rem; max-width: 600px; width: 90%; }
    h1 { font-size: 1.25rem; margin-bottom: 1rem; }
    .error { color: #ef4444; background: rgba(239,68,68,0.1); padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
    .success { color: #22c55e; font-weight: 600; margin-bottom: 1rem; }
    .token-box { background: #1e1e1e; border: 1px solid #333; border-radius: 8px; padding: 1rem; font-family: monospace; font-size: 0.85rem; word-break: break-all; margin: 1rem 0; position: relative; }
    .token-hidden { filter: blur(5px); cursor: pointer; user-select: none; }
    .reveal-btn { background: #3b82f6; color: white; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; margin-right: 0.5rem; }
    .copy-btn { background: #22c55e; color: white; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
    .steps { color: #888; font-size: 0.9rem; line-height: 1.8; margin-top: 1rem; }
    .steps strong { color: #e5e5e5; }
    .warning { color: #eab308; font-size: 0.82rem; margin-top: 1rem; padding: 0.75rem; background: rgba(234,179,8,0.1); border-radius: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Kebab MCP — Google OAuth</h1>
    ${
      error
        ? `<div class="error">${safeError}</div>`
        : `
      <p class="success">Google account connected successfully.</p>
      <p style="color: #888; margin-bottom: 0.5rem;">Your refresh token (click to reveal):</p>
      <div class="token-box">
        <span id="token" class="token-hidden" onclick="reveal()">${safeToken}</span>
      </div>
      <div>
        <button class="reveal-btn" onclick="reveal()">Reveal Token</button>
        <button class="copy-btn" onclick="copyToken()">Copy to Clipboard</button>
      </div>
      <div class="steps">
        <strong>Next steps:</strong><br>
        1. Copy the token above<br>
        2. Go to Vercel → Project Settings → Environment Variables<br>
        3. Set <code style="background:#1e1e1e;padding:2px 6px;border-radius:3px;">GOOGLE_REFRESH_TOKEN</code> to the copied value<br>
        4. Redeploy your project
      </div>
      <div class="warning">
        This token is shown once and is not stored by Kebab MCP. Save it now.
      </div>
      <script>
        function reveal() { document.getElementById('token').classList.remove('token-hidden'); }
        function copyToken() {
          navigator.clipboard.writeText('${safeToken}');
          document.querySelector('.copy-btn').textContent = 'Copied!';
          setTimeout(() => { document.querySelector('.copy-btn').textContent = 'Copy to Clipboard'; }, 2000);
        }
      </script>
    `
    }
  </div>
</body>
</html>`;
}
