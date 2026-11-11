/**
 * REL-02 (2026-11 audit): a credential deleted on another lambda must stop
 * being served once the shared revision moves.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getHydratedCredentialSnapshot,
  invalidateCredentialsIfRevisionChanged,
  resetHydrationFlag,
} from "@/core/credential-store";
import { TenantCache } from "@/core/tenant-cache";
import { runWithTenant } from "@/core/request-context";

describe("credential snapshot revision invalidation", () => {
  beforeEach(() => {
    resetHydrationFlag();
  });

  it("keeps the snapshot while the revision is unchanged", () => {
    invalidateCredentialsIfRevisionChanged("1");
    getHydratedCredentialSnapshot()["SLACK_BOT_TOKEN"] = "x";
    invalidateCredentialsIfRevisionChanged("1");
    expect(getHydratedCredentialSnapshot()["SLACK_BOT_TOKEN"]).toBe("x");
  });

  it("drops the snapshot (incl. deleted creds) when the revision moves", () => {
    invalidateCredentialsIfRevisionChanged("1");
    getHydratedCredentialSnapshot()["SLACK_BOT_TOKEN"] = "x";
    invalidateCredentialsIfRevisionChanged("2");
    expect(getHydratedCredentialSnapshot()["SLACK_BOT_TOKEN"]).toBeUndefined();
  });
});

describe("TenantCache", () => {
  it("isolates values per tenant", async () => {
    const c = new TenantCache<number>();
    c.set(1);
    await runWithTenant("a", () => {
      expect(c.get()).toBeUndefined();
      c.set(2);
    });
    expect(c.get()).toBe(1);
    await runWithTenant("a", () => {
      expect(c.get()).toBe(2);
    });
  });
});
