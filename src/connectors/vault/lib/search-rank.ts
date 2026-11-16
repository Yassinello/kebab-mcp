/**
 * B3 (2026-11 audit): ranked vault search, shared by the KV backend and the
 * GitHub tree-grep fallback.
 *
 * Before, a note matched only when it contained EVERY word of the query:
 * "when is the launch" found nothing (no note says "when is the"), and
 * "pricing workshop" missed a note about an "atelier pricing". Now:
 *   - the query is tokenised, accent- and case-insensitive, and common
 *     English/French stopwords are dropped ("when", "is", "the", "le", ...);
 *   - each remaining term matches as a substring ("launch" → "launched") or
 *     through a light stem ("réunions" → "réunion", "prices" → "price");
 *   - a note needs at least one matching term; its score is the number of
 *     distinct terms it matches, a term found in the title or file name
 *     counting double;
 *   - results are sorted by score, then most recent first.
 *
 * Known limit: no translation or synonyms — "launch" does not find
 * "lancement", "café" does not find "coffee".
 */

/** Accent- and case-insensitive form used for matching. */
export function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

const STOPWORDS = new Set(
  [
    // English
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my no not of on or our so than that the their them then there these they this to too was we were what when where which who why will with would you your about any all also just",
    // French (accents folded)
    "au aux avec ce ces cet cette dans de des du elle en est et etait eu il ils je la le les leur leurs lui ma mais me meme mes moi mon ne nos notre nous on ou par pas pour qu que qui quand quoi comment sa se ses son sont sur ta te tes toi ton tu un une vos votre vous y a d l c j n s t m ete etre fait",
  ]
    .join(" ")
    .split(/\s+/)
    .filter(Boolean)
);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/** Folded word tokens (letters and digits; apostrophes and punctuation split). */
export function tokenize(text: string): string[] {
  return foldText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

const SUFFIXES = [
  "ements",
  "ement",
  "ations",
  "ation",
  "ings",
  "ing",
  "ies",
  "ied",
  "es",
  "ed",
  "s",
  "e",
];

/**
 * Very light stemmer (English + French plurals and common endings). Only
 * used to compare two words — never shown.
 */
export function stem(token: string): string {
  if (token.length <= 3) return token;
  for (const suf of SUFFIXES) {
    if (token.endsWith(suf) && token.length - suf.length >= 3) {
      const base = token.slice(0, -suf.length);
      return suf === "ies" || suf === "ied" ? `${base}y` : base;
    }
  }
  return token;
}

export interface QueryTerm {
  term: string;
  stem: string;
}

/**
 * Distinct search terms of a query, stopwords removed. A query made only of
 * stopwords keeps its words (searching "the" still searches "the").
 */
export function queryTerms(query: string): QueryTerm[] {
  const tokens = tokenize(query);
  const kept = tokens.filter((t) => !isStopword(t));
  const chosen = kept.length > 0 ? kept : tokens;
  const seen = new Set<string>();
  const out: QueryTerm[] = [];
  for (const t of chosen) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ term: t, stem: stem(t) });
  }
  return out;
}

/** Pre-computed searchable form of a text. */
export interface Searchable {
  folded: string;
  tokens: Set<string>;
  stems: Set<string>;
}

export function searchable(text: string): Searchable {
  const folded = foldText(text);
  const tokens = new Set(folded.match(/[\p{L}\p{N}]+/gu) ?? []);
  const stems = new Set<string>();
  for (const t of tokens) stems.add(stem(t));
  return { folded, tokens, stems };
}

/**
 * Does the text contain the term? Terms of 3+ characters match as a
 * substring ("launch" in "launched"); shorter ones only as a whole word
 * ("ai" does not match "said"). Any term also matches through its stem.
 */
export function termMatches(s: Searchable, q: QueryTerm): boolean {
  if (q.term.length >= 3 ? s.folded.includes(q.term) : s.tokens.has(q.term)) return true;
  return s.stems.has(q.stem);
}

export interface NoteScore {
  score: number;
  /** Terms matched anywhere (title, name or content). */
  matched: QueryTerm[];
}

/** Weight of a term found in the title or the file name. */
export const TITLE_WEIGHT = 2;

/**
 * Score a note: each distinct term counts once — TITLE_WEIGHT when found in
 * the title or name, 1 when found only in the content. 0 = no match.
 */
export function scoreNote(
  terms: QueryTerm[],
  title: Searchable,
  content: Searchable | null
): NoteScore {
  let score = 0;
  const matched: QueryTerm[] = [];
  for (const q of terms) {
    if (termMatches(title, q)) {
      score += TITLE_WEIGHT;
      matched.push(q);
    } else if (content && termMatches(content, q)) {
      score += 1;
      matched.push(q);
    }
  }
  return { score, matched };
}

/** Map a position in `foldText(original)` back to a position in `original`. */
function toOriginalIndex(original: string, folded: string, foldedIdx: number): number {
  // Precomposed text folds to the same length (é → e): positions line up.
  if (folded.length === original.length) return foldedIdx;
  let foldedPos = 0;
  for (let i = 0; i < original.length; ) {
    const ch = String.fromCodePoint(original.codePointAt(i) ?? 0);
    const f = foldText(ch);
    if (foldedPos + f.length > foldedIdx) return i;
    foldedPos += f.length;
    i += ch.length;
  }
  return 0;
}

/** Where in a folded line a term (or a word sharing its stem) occurs. */
function termPosition(foldedLine: string, q: QueryTerm): number {
  if (q.term.length >= 3) {
    const i = foldedLine.indexOf(q.term);
    if (i !== -1) return i;
  }
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(foldedLine)) !== null) {
    if (m[0] === q.term || stem(m[0]) === q.stem) return m.index;
  }
  return -1;
}

const SNIPPET_RADIUS = 60;

/**
 * The best passage of `content` for these terms: the line holding the most
 * distinct terms (earliest wins a tie), cut to ~120 characters around the
 * first of them.
 */
export function bestSnippet(content: string, terms: QueryTerm[]): string {
  const lines = content.split("\n");
  let best = { line: -1, hits: 0, pos: 0, term: "" };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const folded = foldText(line);
    let hits = 0;
    let firstPos = Infinity;
    let firstTerm = "";
    for (const q of terms) {
      const p = termPosition(folded, q);
      if (p === -1) continue;
      hits++;
      if (p < firstPos) {
        firstPos = p;
        firstTerm = q.term;
      }
    }
    if (hits > best.hits) best = { line: i, hits, pos: firstPos, term: firstTerm };
    if (best.hits === terms.length) break;
  }
  if (best.line === -1) {
    const first = content.trim().slice(0, SNIPPET_RADIUS * 2);
    return first + (content.trim().length > first.length ? "..." : "");
  }
  const line = lines[best.line]!;
  const folded = foldText(line);
  const at = toOriginalIndex(line, folded, best.pos);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(line.length, at + best.term.length + SNIPPET_RADIUS);
  return (
    (start > 0 ? "..." : "") + line.slice(start, end).trim() + (end < line.length ? "..." : "")
  );
}
