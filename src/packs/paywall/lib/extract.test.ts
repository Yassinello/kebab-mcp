import { describe, it, expect } from "vitest";
import { extractArticle, PaywallExtractError } from "./extract";

const URL = "https://example.com/article";

function wrapHtml(body: string): string {
  return `<!doctype html><html><head><title>Test</title></head><body>${body}</body></html>`;
}

describe("extractArticle login-gate detection", () => {
  it("throws login-gate on a /login form action", () => {
    const html = wrapHtml(`<form action="/login" method="post"><input name="email"/></form>`);
    expect(() => extractArticle(html, URL)).toThrow(PaywallExtractError);
  });

  it("throws login-gate on a /signin action", () => {
    const html = wrapHtml(`<form action="/signin"><input/></form>`);
    expect(() => extractArticle(html, URL)).toThrow(PaywallExtractError);
  });

  it("throws login-gate on Medium paywall marker", () => {
    const html = wrapHtml(`<p>Get full access to every story on Medium.</p>`);
    expect(() => extractArticle(html, URL)).toThrow(PaywallExtractError);
  });

  it("throws login-gate on Substack paid marker", () => {
    const html = wrapHtml(`<p>This post is for paid subscribers only.</p>`);
    expect(() => extractArticle(html, URL)).toThrow(PaywallExtractError);
  });

  it("does not false-positive on body copy mentioning 'sign in'", () => {
    // Provide a long article body so Readability will find content.
    const body = `
      <article>
        <h1>My thoughts on auth</h1>
        ${"<p>You may need to sign in to various services these days. ".repeat(30)}</p>
      </article>
    `;
    const html = wrapHtml(body);
    // Should NOT throw login-gate. It may throw no-article if Readability can't
    // parse this toy HTML, but it must be a different error string than login-gate.
    try {
      const result = extractArticle(html, URL);
      expect(result.markdown.length).toBeGreaterThan(0);
    } catch (err) {
      expect(err).toBeInstanceOf(PaywallExtractError);
      expect((err as PaywallExtractError).message).not.toBe("login-gate");
    }
  });

  it("throws on empty body", () => {
    expect(() => extractArticle(wrapHtml(""), URL)).toThrow(PaywallExtractError);
  });
});
