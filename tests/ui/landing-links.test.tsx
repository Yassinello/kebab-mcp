/**
 * @vitest-environment jsdom
 *
 * LND-01 (Kebab House phase 3) — the landing has the story sections and no
 * dead link: every in-page anchor exists, every internal path is a real
 * route, and every link into this repo's files points at a file that
 * exists in the checkout.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { existsSync } from "node:fs";
import path from "node:path";
import LandingPage from "@/../app/landing/landing-page";
import { REPO_URL } from "@/../app/landing/deploy-url";

afterEach(cleanup);

const ROOT = path.resolve(__dirname, "../..");

function routeExists(pathname: string): boolean {
  const clean = pathname.replace(/[?#].*$/, "").replace(/\/$/, "");
  if (clean === "") return existsSync(path.join(ROOT, "app/page.tsx"));
  return (
    existsSync(path.join(ROOT, "app", clean, "page.tsx")) ||
    existsSync(path.join(ROOT, "app", clean, "route.ts"))
  );
}

describe("landing (LND-01)", () => {
  it("tells the story: ingredients, everywhere, guardrails, at home, install", () => {
    const { container } = render(<LandingPage />);
    for (const id of ["ingredients", "clients", "guardrails", "at-home", "deploy"]) {
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
    }
    const text = container.textContent ?? "";
    expect(text).toContain("and eat it everywhere.");
    for (const word of ["Skills", "Profile", "Memory", "Tools", "Guardrails"]) {
      expect(text).toContain(word);
    }
    expect(text).toMatch(/Docker/);
    // The tool count is not the pitch any more.
    expect(text).not.toMatch(/\b\d{2,3} tools\b/);
  });

  it("has no dead link", () => {
    const { container } = render(<LandingPage />);
    const hrefs = [...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")!);
    expect(hrefs.length).toBeGreaterThan(10);
    const problems: string[] = [];
    for (const href of hrefs) {
      if (href.startsWith("#")) {
        if (href.length > 1 && !container.querySelector(href)) problems.push(`anchor ${href}`);
      } else if (href.startsWith("/")) {
        if (!routeExists(href)) problems.push(`route ${href}`);
      } else if (href.startsWith(`${REPO_URL}/blob/main/`)) {
        const file = href.slice(`${REPO_URL}/blob/main/`.length).replace(/#.*$/, "");
        if (!existsSync(path.join(ROOT, file))) problems.push(`file ${file}`);
      } else if (!/^https:\/\//.test(href)) {
        problems.push(`scheme ${href}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
