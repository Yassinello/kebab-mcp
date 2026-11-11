/**
 * Messaging provider registry (ADR 0002).
 *
 * `getMessagingProvider()` returns the adapter selected by
 * `KEBAB_MESSAGING_PROVIDER` (default "unipile"). Adding a vendor = one
 * adapter file + one entry in `FACTORIES`. Unknown values fall back to
 * Unipile with a warning rather than breaking every tool.
 *
 * Adapters are stateless (the Unipile one fetches its memoized SDK client per
 * call), so a module-level cache per id is safe across warm lambdas.
 */

import { getConfig } from "@/core/config-facade";
import { getLogger } from "@/core/logging";
import { UnipileMessagingProvider } from "./unipile";
import type { FullProvider } from "./types";

const log = getLogger("CONNECTOR:unipile");

const FACTORIES: Record<string, () => FullProvider> = {
  unipile: () => new UnipileMessagingProvider(),
};

const cache = new Map<string, FullProvider>();
let testOverride: FullProvider | null = null;

function selectedId(): string {
  let raw: string | undefined;
  try {
    raw = getConfig("KEBAB_MESSAGING_PROVIDER");
  } catch {
    raw = undefined;
  }
  const id = raw?.trim().toLowerCase() || "unipile";
  if (!FACTORIES[id]) {
    log.warn("Unknown KEBAB_MESSAGING_PROVIDER — falling back to unipile", { requested: id });
    return "unipile";
  }
  return id;
}

export function getMessagingProvider(): FullProvider {
  if (testOverride) return testOverride;
  const id = selectedId();
  let p = cache.get(id);
  if (!p) {
    p = FACTORIES[id]!();
    cache.set(id, p);
  }
  return p;
}

/** Test-only: inject a fake provider (pass null to restore the real one). */
export function __setMessagingProviderForTests(p: FullProvider | null): void {
  testOverride = p;
}

export type * from "./types";
