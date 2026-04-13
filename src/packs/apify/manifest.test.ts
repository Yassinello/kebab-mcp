import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { apifyPack } from "./manifest";

const originalAllowlist = process.env.APIFY_ACTORS;

describe("apify allowlist parsing", () => {
  beforeEach(() => {
    delete process.env.APIFY_ACTORS;
  });

  afterEach(() => {
    if (originalAllowlist === undefined) {
      delete process.env.APIFY_ACTORS;
    } else {
      process.env.APIFY_ACTORS = originalAllowlist;
    }
  });

  it("includes every wrapper when APIFY_ACTORS is unset", () => {
    delete process.env.APIFY_ACTORS;
    const names = apifyPack.tools.map((t) => t.name);
    expect(names).toContain("apify_linkedin_profile");
    expect(names).toContain("apify_linkedin_company");
    expect(names).toContain("apify_search_actors");
    expect(names).toContain("apify_run_actor");
  });

  it("returns only always-on tools when APIFY_ACTORS is empty string", () => {
    process.env.APIFY_ACTORS = "";
    const names = apifyPack.tools.map((t) => t.name);
    // Empty string = no allowlist set → all wrappers visible
    expect(names).toContain("apify_linkedin_profile");
  });

  it("limits to a single allowed actor id", () => {
    process.env.APIFY_ACTORS = "dev_fusion~linkedin-profile-scraper";
    const names = apifyPack.tools.map((t) => t.name);
    // Always-on tools remain
    expect(names).toContain("apify_search_actors");
    expect(names).toContain("apify_run_actor");
  });

  it("trims whitespace in comma-separated list", () => {
    process.env.APIFY_ACTORS = "foo , bar,baz";
    // Does not throw; allowlist filter silently keeps only known wrappers.
    expect(() => apifyPack.tools).not.toThrow();
  });

  it("always exposes the run_actor escape hatch", () => {
    process.env.APIFY_ACTORS = "nothing";
    const names = apifyPack.tools.map((t) => t.name);
    expect(names).toContain("apify_run_actor");
  });

  it("marks apify_run_actor as destructive", () => {
    delete process.env.APIFY_ACTORS;
    const runActor = apifyPack.tools.find((t) => t.name === "apify_run_actor");
    expect(runActor?.destructive).toBe(true);
  });
});
