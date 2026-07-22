/**
 * The markdown syntax blurb shared by every Notion tool that accepts page
 * content (`notion_create.content`, `notion_update.append_content` /
 * `.replace_content`).
 *
 * Defined once for two reasons:
 *   1. **Token cost** — tool descriptions ship on every `tools/list`, to every
 *      client, on every session. Three copies of this text is three times the
 *      per-call overhead for zero added information.
 *   2. **Drift** — the syntax the converter accepts is one thing. Three hand-
 *      maintained copies of the list would diverge the first time someone adds
 *      a block type and updates only the description they were looking at.
 *
 * Keep this in sync with `markdownToBlocks` (see the symmetry-contract comment
 * in `notion-api.ts`): if a construct is listed here, both the writer AND the
 * reader must support it.
 */
export const MARKDOWN_SYNTAX_HELP =
  "Markdown → native Notion blocks: headings (#/##/###), bulleted/numbered lists, " +
  "checkboxes ([ ]/[x]), fenced code (```lang), dividers (---), tables (| a | b | with a " +
  "| --- | header row), callouts (> [!💡] text, optional trailing {blue_background}), " +
  "toggles (<details> summary + 2-space-indented body), images (![caption](url)), " +
  "[bookmark](url), [embed](url), and inline **bold** / *italic* / `code` / ~~strike~~ / " +
  "[links](url).";
