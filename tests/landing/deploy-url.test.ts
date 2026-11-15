import { describe, it, expect } from "vitest";

describe("deploy-url constants", () => {
  it("REPO_URL exports the kebab-mcp GitHub URL", async () => {
    const { REPO_URL } = await import("../../app/landing/deploy-url");
    expect(REPO_URL).toBe("https://github.com/Yassinello/kebab-mcp");
  });

  it("UPSTREAM_OWNER is 'Yassinello' derived from REPO_URL", async () => {
    const { UPSTREAM_OWNER } = await import("../../app/landing/deploy-url");
    expect(UPSTREAM_OWNER).toBe("Yassinello");
  });

  it("UPSTREAM_REPO_SLUG is 'kebab-mcp' derived from REPO_URL", async () => {
    const { UPSTREAM_REPO_SLUG } = await import("../../app/landing/deploy-url");
    expect(UPSTREAM_REPO_SLUG).toBe("kebab-mcp");
  });

  it("UPSTREAM_OWNER and UPSTREAM_REPO_SLUG are derived from REPO_URL segments", async () => {
    const { REPO_URL, UPSTREAM_OWNER, UPSTREAM_REPO_SLUG } =
      await import("../../app/landing/deploy-url");
    const segments = REPO_URL.split("/");
    expect(UPSTREAM_OWNER).toBe(segments.at(-2));
    expect(UPSTREAM_REPO_SLUG).toBe(segments.at(-1));
  });
});

describe("VERCEL_DEPLOY_BUTTON_URL (DEP-01)", () => {
  it("decodes to the clone flow with repo, names and an Upstash KV store", async () => {
    const { VERCEL_DEPLOY_BUTTON_URL, REPO_URL } = await import("../../app/landing/deploy-url");
    const url = new URL(VERCEL_DEPLOY_BUTTON_URL);
    expect(url.origin + url.pathname).toBe("https://vercel.com/new/clone");
    expect(url.searchParams.get("repository-url")).toBe(REPO_URL);
    expect(url.searchParams.get("project-name")).toBe("kebab-house");
    expect(url.searchParams.get("repository-name")).toBe("kebab-house");

    const stores = JSON.parse(url.searchParams.get("stores")!) as unknown;
    expect(stores).toEqual([
      { type: "integration", integrationSlug: "upstash", productSlug: "upstash-kv" },
    ]);
  });

  it("percent-encodes the JSON (no raw brackets, braces or quotes in the URL)", async () => {
    const { VERCEL_DEPLOY_BUTTON_URL } = await import("../../app/landing/deploy-url");
    for (const ch of ["[", "]", "{", "}", '"']) expect(VERCEL_DEPLOY_BUTTON_URL).not.toContain(ch);
    const raw = VERCEL_DEPLOY_BUTTON_URL.split("stores=")[1]!;
    expect(JSON.parse(decodeURIComponent(raw))[0].integrationSlug).toBe("upstash");
  });
});

describe("README Deploy links (DEP-04)", () => {
  it("every Vercel clone link in the README is the Deploy Button URL", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { VERCEL_DEPLOY_BUTTON_URL } = await import("../../app/landing/deploy-url");
    const readme = readFileSync(join(__dirname, "../../README.md"), "utf8");
    const links = readme.match(/https:\/\/vercel\.com\/new\/clone\?[^\s)"'<>]+/g) ?? [];
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) expect(link).toBe(VERCEL_DEPLOY_BUTTON_URL);
  });
});
