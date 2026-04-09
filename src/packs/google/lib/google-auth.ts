let cachedToken: { access_token: string; expires_at: number } | null = null;

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly hint: string
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export async function getGoogleAccessToken(): Promise<string> {
  // Return cached token if still valid (with 5min margin)
  if (cachedToken && Date.now() < cachedToken.expires_at - 300_000) {
    return cachedToken.access_token;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [
      !clientId && "GOOGLE_CLIENT_ID",
      !clientSecret && "GOOGLE_CLIENT_SECRET",
      !refreshToken && "GOOGLE_REFRESH_TOKEN",
    ].filter(Boolean);
    throw new GoogleAuthError(
      `Missing env vars: ${missing.join(", ")}`,
      "missing_config",
      "Add the missing variables in Vercel → Settings → Environment Variables, then redeploy."
    );
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();

  if (!data.access_token) {
    const errorCode = data.error || "unknown";
    const errorDesc = data.error_description || "";

    const hints: Record<string, string> = {
      invalid_client:
        "Le client OAuth n'existe pas ou a été supprimé. Vérifie GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans Vercel, puis vérifie que l'app existe dans Google Cloud Console → Credentials.",
      invalid_grant:
        "Le refresh token a été révoqué ou est expiré. Relance get-token.js pour en obtenir un nouveau, puis mets à jour GOOGLE_REFRESH_TOKEN dans Vercel.",
      unauthorized_client:
        "Le client OAuth n'est pas autorisé pour ce grant type. Vérifie que l'app est de type 'Desktop' dans Google Cloud Console.",
      invalid_scope:
        "Un ou plusieurs scopes demandés ne sont pas autorisés. Vérifie les scopes dans Google Cloud Console → OAuth consent screen → Scopes.",
    };

    throw new GoogleAuthError(
      `Google OAuth failed: ${errorCode} — ${errorDesc}`,
      errorCode,
      hints[errorCode] || `Erreur inconnue (${errorCode}). Vérifie les 3 variables GOOGLE_* dans Vercel.`
    );
  }

  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };

  return cachedToken.access_token;
}
