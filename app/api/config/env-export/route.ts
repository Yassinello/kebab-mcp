import { NextResponse } from "next/server";
import { getEnvStore } from "@/core/env-store";
import { readAllCredentialsFromKV } from "@/core/credential-store";
import { getInstanceConfigAsync, SETTINGS_ENV_KEYS } from "@/core/config";
import { withAdminAuth } from "@/core/with-admin-auth";
import { toMsg } from "@/core/error-utils";

/**
 * GET /api/config/env-export
 * Returns all credentials as plain text .env format (unmasked).
 * Auth-gated. KV credentials take precedence over env vars.
 */
async function getHandler() {
  try {
    // Read from EnvStore (filesystem or Vercel API)
    let envVars: Record<string, string> = {};
    try {
      const store = getEnvStore();
      envVars = await store.read();
    } catch {
      // EnvStore may fail on Vercel without VERCEL_TOKEN — that's ok
    }

    // Read KV-backed credentials (takes precedence)
    const kvCreds = await readAllCredentialsFromKV();

    // Read KV-backed settings
    const config = await getInstanceConfigAsync();
    const settingsVars: Record<string, string> = {
      MYMCP_DISPLAY_NAME: config.displayName,
      MYMCP_TIMEZONE: config.timezone,
      MYMCP_LOCALE: config.locale,
      MYMCP_CONTEXT_PATH: config.contextPath,
    };

    // Merge: env < KV creds < settings (KV takes precedence)
    const merged = { ...envVars, ...kvCreds, ...settingsVars };

    // Filter out meta env vars that aren't useful in a .env export
    const skipKeys = new Set([
      "VERCEL",
      "VERCEL_ENV",
      "VERCEL_URL",
      "VERCEL_REGION",
      "VERCEL_GIT_COMMIT_SHA",
      "VERCEL_GIT_COMMIT_REF",
      "VERCEL_GIT_PROVIDER",
      "VERCEL_GIT_REPO_SLUG",
      "VERCEL_GIT_REPO_OWNER",
      "VERCEL_GIT_COMMIT_MESSAGE",
      "VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
      "VERCEL_GIT_COMMIT_AUTHOR_NAME",
      "VERCEL_GIT_PULL_REQUEST_ID",
      "NODE_ENV",
      "NEXT_RUNTIME",
      "__NEXT_PRIVATE_STANDALONE_CONFIG",
    ]);

    const lines: string[] = [
      "# Kebab MCP — exported credentials",
      `# Exported: ${new Date().toISOString()}`,
      "",
    ];

    // Group: settings first, then credentials
    const settingsKeys = new Set<string>(SETTINGS_ENV_KEYS);
    const sortedKeys = Object.keys(merged).sort((a, b) => {
      const aSettings = settingsKeys.has(a) ? 0 : 1;
      const bSettings = settingsKeys.has(b) ? 0 : 1;
      if (aSettings !== bSettings) return aSettings - bSettings;
      return a.localeCompare(b);
    });

    let section = "";
    for (const key of sortedKeys) {
      if (skipKeys.has(key)) continue;
      const value = merged[key];
      if (!value) continue;

      const newSection = settingsKeys.has(key) ? "settings" : "credentials";
      if (newSection !== section) {
        if (section) lines.push("");
        lines.push(`# ${newSection === "settings" ? "Settings" : "Credentials"}`);
        section = newSection;
      }
      lines.push(`${key}=${value}`);
    }

    lines.push("");
    const text = lines.join("\n");

    return new NextResponse(text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="kebab-mcp-credentials.env"',
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
