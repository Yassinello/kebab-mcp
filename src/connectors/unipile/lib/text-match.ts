/**
 * Accent- and case-insensitive matching helpers for the find / search tools.
 * "Réunion Borderland" matches query "reunion border".
 */

export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Split a query into normalized, non-empty terms. */
export function queryTerms(query: string): string[] {
  return normalizeText(query)
    .split(" ")
    .filter((t) => t.length > 0);
}

/** True when EVERY term occurs somewhere in `haystack`. */
export function matchesAllTerms(haystack: string | null | undefined, terms: string[]): boolean {
  if (!haystack || terms.length === 0) return false;
  const h = normalizeText(haystack);
  return terms.every((t) => h.includes(t));
}

/** Digits only ("+33 6 12-34" → "33612 34" → "336 1234"). */
export function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/** Short excerpt of `text` centred on the first term hit (for search results). */
export function snippet(text: string, terms: string[], radius = 120): string {
  if (text.length <= radius * 2) return text;
  const norm = normalizeText(text);
  // normalizeText collapses whitespace, so indices are approximate on
  // multi-space input — good enough for a display excerpt.
  const idx = terms.reduce((best, t) => {
    const i = norm.indexOf(t);
    return i >= 0 && (best < 0 || i < best) ? i : best;
  }, -1);
  const start = Math.max(0, (idx < 0 ? 0 : idx) - radius);
  const end = Math.min(text.length, start + radius * 2);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
