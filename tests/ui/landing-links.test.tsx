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
  it("tells the story: who, ingredients, how, everywhere, guardrails, at home, FAQ, install", () => {
    const { container } = render(<LandingPage />);
    for (const id of [
      "deploy",
      "who",
      "ingredients",
      "how-it-works",
      "clients",
      "product",
      "whats-inside",
      "guardrails",
      "at-home",
      "faq",
    ]) {
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
    }
    const text = container.textContent ?? "";
    expect(text).toContain("and eat it everywhere.");
    expect(text).toContain("Your skills, profile and memory in every AI client");
    // Audience and prerequisites are stated.
    expect(text).toMatch(/more than one AI client/);
    expect(text).toMatch(/GitHub account/);
    expect(text).toMatch(/free Vercel account/);
    for (const word of ["Skills", "Profile", "Memory", "Tools", "Guardrails"]) {
      expect(text).toContain(word);
    }
    expect(text).toMatch(/Docker/);
    // The tool count is not the pitch any more.
    expect(text).not.toMatch(/\b\d{2,3} tools\b/);
    // Outdated claims are gone.
    expect(text).not.toMatch(/with its own token/);
    expect(text).not.toMatch(/Everything is logged/);
    expect(text).not.toMatch(/linkedin-reply/);
    expect(text).not.toMatch(/Deploy your Kebab/);
  });

  it("hero: one deploy button, a how-it-works anchor, copy before the illustration", () => {
    const { container } = render(<LandingPage />);
    const hero = container.querySelector("#deploy")!;
    const links = [...hero.querySelectorAll("a")].map((a) => a.textContent?.trim());
    expect(links).toContain("Deploy Kebab House");
    expect(links).toContain("See how it works");
    expect(hero.querySelector('a[href="#how-it-works"]')).not.toBeNull();
    // The illustration shows the ingredients, not third-party services.
    const svg = hero.querySelector("svg[role=img]")!;
    expect(svg.querySelector("title")?.textContent).toMatch(/skills, profile, memory/);
    expect(svg.textContent).not.toMatch(/Gmail|Notion|Slack|GitHub/);
    // Mobile order = DOM order: the deploy button comes before the illustration.
    const deploy = [...hero.querySelectorAll("a")].find(
      (a) => a.textContent === "Deploy Kebab House"
    )!;
    expect(deploy.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(svg.closest("[class*='order-first']")).toBeNull();
  });

  it("dashboard mockup matches the real menu and ritual templates", () => {
    const { container } = render(<LandingPage />);
    const product = container.querySelector("#product")!.textContent ?? "";
    for (const item of [
      "Overview",
      "Profile",
      "Skills",
      "Memory",
      "Connectors",
      "Devices",
      "Logs",
    ]) {
      expect(product).toContain(item);
    }
    for (const ritual of [
      "remember",
      "morning-brief",
      "meeting-prep",
      "weekly-review",
      "read-later",
      "handoff",
    ]) {
      expect(product).toContain(ritual);
    }
  });

  it("guardrails copy matches the approval and access-level reality", () => {
    const { container } = render(<LandingPage />);
    const g = container.querySelector("#guardrails")!.textContent ?? "";
    for (const channel of ["Gmail", "Slack", "Google Chat", "LinkedIn", "WhatsApp"]) {
      expect(g).toContain(channel);
    }
    expect(g).toMatch(/read only, read \+ my profile and notes, or everything/);
    expect(g).toMatch(/counted per client each week/);
    expect(container.querySelector("#at-home")!.textContent).toMatch(/secrets excluded/);
  });

  it("the install section points to the Set it up from Claude guide", () => {
    const { container } = render(<LandingPage />);
    const link = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "Set it up from Claude"
    );
    expect(link?.getAttribute("href")).toBe(`${REPO_URL}/blob/main/docs/CONNECT-CLAUDE.md`);
    expect(link?.closest("p")?.textContent).toMatch(
      /connect Claude and say “Set up my Kebab House”/
    );
  });

  it("has a collapsible FAQ", () => {
    const { container } = render(<LandingPage />);
    const items = container.querySelectorAll("#faq details");
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items.length).toBeLessThanOrEqual(6);
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
