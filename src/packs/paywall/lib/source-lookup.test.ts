import { describe, it, expect } from "vitest";
import { findSourceForUrl } from "./source-lookup";

describe("findSourceForUrl — Medium", () => {
  it("matches bare medium.com", () => {
    expect(findSourceForUrl("https://medium.com/p/abc")?.id).toBe("medium");
  });

  it("matches Medium subdomains", () => {
    expect(findSourceForUrl("https://foo.medium.com/article-123")?.id).toBe("medium");
  });

  it("matches towardsdatascience", () => {
    expect(findSourceForUrl("https://towardsdatascience.com/thing")?.id).toBe("medium");
  });

  it("matches with trailing slash", () => {
    expect(findSourceForUrl("https://medium.com/")?.id).toBe("medium");
  });

  it("matches with query params", () => {
    expect(findSourceForUrl("https://medium.com/p/abc?source=newsletter")?.id).toBe("medium");
  });

  it("is case-insensitive on hostname", () => {
    expect(findSourceForUrl("https://MEDIUM.COM/p/abc")?.id).toBe("medium");
  });
});

describe("findSourceForUrl — Substack", () => {
  it("matches *.substack.com", () => {
    expect(findSourceForUrl("https://stratechery.substack.com/p/foo")?.id).toBe("substack");
  });

  it("matches substack.com root", () => {
    expect(findSourceForUrl("https://substack.com/home")?.id).toBe("substack");
  });
});

describe("findSourceForUrl — no match", () => {
  it("returns null for unrelated domains", () => {
    expect(findSourceForUrl("https://nytimes.com/article")).toBeNull();
  });

  it("returns null for invalid URL", () => {
    expect(findSourceForUrl("not a url")).toBeNull();
  });

  it("does not match Medium lookalikes", () => {
    expect(findSourceForUrl("https://notmedium.com/foo")).toBeNull();
  });
});
