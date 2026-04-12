import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export interface ParsedArticle {
  title: string;
  author: string | null;
  date: string | null;
  markdown: string;
  wordCount: number;
}

export class PaywallExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaywallExtractError";
  }
}

/**
 * Heuristic: does the raw HTML look like a login/paywall gate?
 * We consider the extraction failed (expired cookie) when Readability
 * returned no article OR the page exposes a login form / "Sign in" marker.
 */
function looksLikeLoginGate(html: string): boolean {
  const lower = html.toLowerCase();
  // <form action="/login"> / action="/signin" / action*="login"
  if (/<form[^>]*action\s*=\s*["'][^"']*(?:login|signin|sign-in)/i.test(html)) {
    return true;
  }
  // Specific Medium/Substack markers only (avoid false positives on articles
  // that casually mention "sign in" in body copy).
  if (lower.includes("get full access to every story")) return true;
  if (lower.includes("this post is for paid subscribers")) return true;
  if (lower.includes("this post is for paying subscribers")) return true;
  return false;
}

let turndownInstance: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (turndownInstance) return turndownInstance;
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  td.use(gfm);
  // Drop script/style just in case Readability leaves them in
  td.remove(["script", "style", "noscript"]);
  turndownInstance = td;
  return td;
}

/**
 * Parse raw HTML into a clean markdown article using Readability + Turndown.
 * Throws `PaywallExtractError` if the page looks like a login wall or if
 * Readability cannot find an article.
 */
export function extractArticle(html: string, url: string): ParsedArticle {
  if (looksLikeLoginGate(html)) {
    throw new PaywallExtractError("login-gate");
  }

  // linkedom returns a DOM-ish object that Readability accepts.
  // Cast through `unknown` — Readability's type wants a real Document,
  // but linkedom's Document is structurally compatible at runtime.
  const { document } = parseHTML(html);
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();

  if (!article || !article.content || article.content.trim().length === 0) {
    throw new PaywallExtractError("no-article");
  }

  const markdown = getTurndown().turndown(article.content).trim();
  if (!markdown || markdown.length < 50) {
    // A near-empty article body is the classic "cookie expired" signal.
    throw new PaywallExtractError("no-article");
  }

  const wordCount = markdown.split(/\s+/).filter(Boolean).length;

  // Readability exposes `byline` and `publishedTime` when available.
  type ReadabilityExtras = { byline?: string | null; publishedTime?: string | null };
  const extras = article as unknown as ReadabilityExtras;

  return {
    title: (article.title || new URL(url).hostname).trim(),
    author: extras.byline?.trim() || null,
    date: extras.publishedTime || null,
    markdown,
    wordCount,
  };
}
