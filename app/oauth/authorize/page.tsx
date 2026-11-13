import { headers } from "next/headers";
import { OAuthError, readAuthorizeParams, validateAuthorize } from "@/core/oauth";
import { listProfiles } from "@/core/profiles";
import { getConfig } from "@/core/config-facade";
import { AuthorizeForm } from "./authorize-form";

export const dynamic = "force-dynamic";

/**
 * Kebab House phase 1 (OAU-06) — OAuth consent page. Owner-only: the edge
 * proxy gates it like /config. Client and redirect errors are shown here
 * and never redirected (the redirect target is not trusted yet).
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") sp.set(k, v);

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const override = getConfig("KEBAB_PUBLIC_URL")?.trim();
  const origin = override ? new URL(override).origin : `${proto}://${host}`;

  let error: string | null = null;
  let client: { name: string; id: string; redirectHost: string; kind: string } | null = null;
  try {
    const v = await validateAuthorize(readAuthorizeParams(sp), origin);
    client = {
      name: v.client.client_name,
      id: v.client.client_id,
      redirectHost: new URL(v.redirect_uri).host,
      kind: v.client.kind,
    };
  } catch (err) {
    error = err instanceof OAuthError ? err.message : "Invalid authorization request.";
  }

  const profiles = client ? (await listProfiles()).map((p) => p.name) : [];

  return (
    <main className="min-h-screen bg-bg text-text flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md border border-border rounded-xl p-6 bg-bg">
        <p className="text-xs uppercase tracking-wide text-text-muted mb-1">Kebab House</p>
        {error || !client ? (
          <>
            <h1 className="text-lg font-semibold mb-2">This connection request is not valid</h1>
            <p className="text-sm text-text-dim">{error}</p>
            <p className="text-xs text-text-muted mt-4">
              Go back to your AI client and try adding the connector again.
            </p>
          </>
        ) : (
          <AuthorizeForm
            query={sp.toString()}
            clientName={client.name}
            clientId={client.id}
            clientKind={client.kind}
            redirectHost={client.redirectHost}
            profiles={profiles}
          />
        )}
      </div>
    </main>
  );
}
