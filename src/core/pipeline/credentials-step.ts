/**
 * hydrateCredentialsStep — PIPE-02.
 *
 * Hydrates `cred:*` KV entries into the in-process snapshot (lazy,
 * idempotent per process), then runs the continuation inside
 * `runWithCredentials(snapshot, next)` so the handler sees credentials
 * via `getCredential()` without mutating `process.env` (SEC-02).
 *
 * Extracted from the pre-Phase-41 `[transport]/route.ts` preamble:
 *   await hydrateCredentialsFromKV();
 *   ...
 *   requestContext.run({ tenantId, credentials: getHydratedCredentialSnapshot() }, ...)
 */

import type { Step } from "./types";
import {
  hydrateCredentialsFromKV,
  getHydratedCredentialSnapshot,
  invalidateCredentialsIfRevisionChanged,
} from "../credential-store";
import { getConfigRevision } from "../config-revision";
import { runWithCredentials } from "../request-context";

export const hydrateCredentialsStep: Step = async (ctx, next) => {
  // REL-02: re-hydrate when another lambda changed credentials.
  const previous = getHydratedCredentialSnapshot();
  invalidateCredentialsIfRevisionChanged(await getConfigRevision());
  await hydrateCredentialsFromKV();
  let current = getHydratedCredentialSnapshot();
  // If the re-hydration failed (KV blip) or a concurrent invalidation left
  // an empty snapshot, serve the last good one rather than no credentials;
  // the next request retries.
  if (Object.keys(current).length === 0 && Object.keys(previous).length > 0) {
    current = previous;
  }
  const snapshot = { ...current };
  ctx.credentials = snapshot;
  // Wrap `next()` so downstream steps + the handler resolve credentials via
  // the request-scoped override map. Note: `runWithCredentials` preserves
  // the existing tenantId on the ambient requestContext (it only merges
  // credentials), so the authStep's tenant propagation is not disturbed.
  return runWithCredentials(snapshot, () => next()) as Promise<Response>;
};
