import { Google } from "arctic";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { getConfig } from "@/core/config-facade";

/**
 * Initiates Google OAuth consent flow.
 * Redirects user to Google's consent page.
 * Admin auth required.
 */
async function getHandler(ctx: PipelineContext) {
  const clientId = getConfig("GOOGLE_CLIENT_ID");
  const clientSecret = getConfig("GOOGLE_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    return Response.json(
      {
        error: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set before using OAuth flow",
      },
      { status: 400 }
    );
  }

  const vercelUrl = getConfig("VERCEL_URL");
  const baseUrl = vercelUrl ? `https://${vercelUrl}` : "http://localhost:3000";

  const google = new Google(clientId, clientSecret, `${baseUrl}/api/auth/google/callback`);

  const scopes = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/chat.messages.create",
  ];

  const state = crypto.randomUUID();
  const codeVerifier = crypto.randomUUID() + crypto.randomUUID();
  const url = google.createAuthorizationURL(state, codeVerifier, scopes);

  // Store state + verifier in a cookie (short-lived)
  const cookieValue = JSON.stringify({ state, codeVerifier });
  const response = new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      // SEC-15: Secure whenever the request came over HTTPS.
      "Set-Cookie": `mymcp_oauth=${encodeURIComponent(cookieValue)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${
        new URL(ctx.request.url).protocol === "https:" ? "; Secure" : ""
      }`,
    },
  });

  return response;
}

export const GET = withAdminAuth(getHandler);
