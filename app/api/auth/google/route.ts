import { Google } from "arctic";
import { checkAdminAuth } from "@/core/auth";

/**
 * Initiates Google OAuth consent flow.
 * Redirects user to Google's consent page.
 * Admin auth required.
 */
export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return Response.json(
      {
        error: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set before using OAuth flow",
      },
      { status: 400 }
    );
  }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const google = new Google(clientId, clientSecret, `${baseUrl}/api/auth/google/callback`);

  const scopes = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
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
      "Set-Cookie": `mymcp_oauth=${encodeURIComponent(cookieValue)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });

  return response;
}
