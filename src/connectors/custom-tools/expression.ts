/**
 * Strict-Mustache expression engine for Custom Tools.
 *
 * Supported syntax (and ONLY this syntax — anything else is parsed as
 * literal text or rejected):
 *
 *   {{var}}                — interpolate a context value (HTML-unsafe; raw)
 *   {{ var.field.nested }} — dotted property access on objects
 *   {{#var}}…{{/var}}      — conditional render: emit body iff `var` is
 *                            truthy (non-empty string, non-zero number,
 *                            true, or non-empty array/object)
 *   {{^var}}…{{/var}}      — inverse conditional (emit body when falsy)
 *
 * Deliberately NOT supported (refused at parse time so authors learn
 * early instead of getting silent surprises):
 *
 *   {{{var}}}              — no triple-stash; everything is raw already
 *   {{> partial}}          — no partials
 *   {{=…=}}                — no delimiter swap
 *   {{!comment}}           — no comments (use markdown around the block)
 *   anything else with $   — no JS, no helpers, no lambdas
 *
 * Why strict: a Custom Tool runs whatever sequence of internal Kebab
 * tools the user composes — including write paths (vault_write,
 * slack_send, etc.). The expression engine is the only place user input
 * meets that orchestration. Anything more permissive than dot-access +
 * conditionals invites "trust me, just eval()" pressure that we will
 * not survive a security audit.
 */

import { toMsg } from "@/core/error-utils";

// ── AST ───────────────────────────────────────────────────────────────

type Node =
  | { kind: "text"; value: string }
  | { kind: "var"; path: string[] }
  | { kind: "section"; inverted: boolean; path: string[]; body: Node[] };

interface ParseFrame {
  inverted: boolean;
  path: string[];
  body: Node[];
}

// ── Public API ────────────────────────────────────────────────────────

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

/**
 * Render `template` against `context`. Throws `ExpressionError` for
 * malformed templates and unsupported tag forms; missing variables are
 * rendered as the empty string (Mustache-default behavior — keeps the
 * template terse for optional fields like `priority` / `due`).
 */
export function renderTemplate(template: string, context: Record<string, unknown>): string {
  const ast = parse(template);
  return renderNodes(ast, context);
}

/**
 * Parse-only — useful for early validation in the writer path so authors
 * see a 400 with the exact column instead of a runtime crash. Throws
 * `ExpressionError` on the same conditions as renderTemplate.
 */
export function validateTemplate(template: string): void {
  parse(template);
}

// ── Parser ────────────────────────────────────────────────────────────

const TAG = /\{\{(?<inner>[\s\S]*?)\}\}/g;

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: ParseFrame[] = [];
  let cursor = 0;

  // We re-use a single regex but reset lastIndex per call — `.exec()` in a
  // loop is the documented stateful API and avoids a String.matchAll
  // allocation in the hot render path.
  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG.exec(template)) !== null) {
    const fullStart = match.index;
    const fullEnd = TAG.lastIndex;
    const inner = match.groups?.inner ?? "";

    // Emit the literal slice between the previous tag and this one.
    if (fullStart > cursor) {
      pushText(stack, root, template.slice(cursor, fullStart));
    }
    cursor = fullEnd;

    const trimmed = inner.trim();
    if (trimmed.length === 0) {
      throw new ExpressionError(`empty {{}} tag at offset ${fullStart}`);
    }

    // Refuse explicitly-blocked Mustache features so authors don't paste
    // a snippet from the wider Mustache ecosystem and silently get a
    // weaker security posture.
    if (inner.startsWith("{") || inner.endsWith("}")) {
      throw new ExpressionError(
        `triple-stash {{{...}}} is not supported (offset ${fullStart}); use {{var}} — output is already raw`
      );
    }
    if (trimmed.startsWith("!") || trimmed.startsWith(">") || trimmed.startsWith("=")) {
      throw new ExpressionError(
        `unsupported Mustache tag '${trimmed[0]}' at offset ${fullStart} (comments, partials, and delimiter swaps are disabled)`
      );
    }
    if (trimmed.startsWith("&")) {
      throw new ExpressionError(
        `unsupported Mustache tag '&' at offset ${fullStart} (unescape modifier is redundant — output is already raw)`
      );
    }

    // Section open / close / inverse / variable.
    if (trimmed.startsWith("#") || trimmed.startsWith("^")) {
      const inverted = trimmed.startsWith("^");
      const rawPath = trimmed.slice(1).trim();
      const path = parsePath(rawPath, fullStart);
      stack.push({ inverted, path, body: [] });
      continue;
    }
    if (trimmed.startsWith("/")) {
      const rawPath = trimmed.slice(1).trim();
      const closing = parsePath(rawPath, fullStart);
      const top = stack.pop();
      if (!top) {
        throw new ExpressionError(`unmatched closing tag {{/${rawPath}}} at offset ${fullStart}`);
      }
      if (top.path.join(".") !== closing.join(".")) {
        throw new ExpressionError(
          `closing tag {{/${closing.join(".")}}} does not match opening {{${
            top.inverted ? "^" : "#"
          }${top.path.join(".")}}} at offset ${fullStart}`
        );
      }
      const node: Node = {
        kind: "section",
        inverted: top.inverted,
        path: top.path,
        body: top.body,
      };
      pushNode(stack, root, node);
      continue;
    }

    // Plain interpolation.
    const path = parsePath(trimmed, fullStart);
    pushNode(stack, root, { kind: "var", path });
  }

  // Trailing literal after the last tag.
  if (cursor < template.length) {
    pushText(stack, root, template.slice(cursor));
  }

  if (stack.length > 0) {
    const open = stack[stack.length - 1]!;
    throw new ExpressionError(
      `unclosed section {{${open.inverted ? "^" : "#"}${open.path.join(".")}}}`
    );
  }
  return root;
}

const PATH_SEGMENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function parsePath(raw: string, offset: number): string[] {
  if (raw.length === 0) {
    throw new ExpressionError(`empty path at offset ${offset}`);
  }
  const parts = raw.split(".");
  for (const seg of parts) {
    if (!PATH_SEGMENT.test(seg)) {
      throw new ExpressionError(
        `invalid path segment '${seg}' at offset ${offset} (only [a-zA-Z_][a-zA-Z0-9_]* and dot)`
      );
    }
  }
  return parts;
}

function pushNode(stack: ParseFrame[], root: Node[], node: Node): void {
  if (stack.length === 0) {
    root.push(node);
  } else {
    stack[stack.length - 1]!.body.push(node);
  }
}

function pushText(stack: ParseFrame[], root: Node[], value: string): void {
  if (value.length === 0) return;
  pushNode(stack, root, { kind: "text", value });
}

// ── Renderer ──────────────────────────────────────────────────────────

function renderNodes(nodes: Node[], context: Record<string, unknown>): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += node.value;
    } else if (node.kind === "var") {
      out += stringify(resolve(node.path, context));
    } else {
      const value = resolve(node.path, context);
      const truthy = isTruthy(value);
      if (node.inverted ? !truthy : truthy) {
        out += renderNodes(node.body, context);
      }
    }
  }
  return out;
}

function resolve(path: string[], context: Record<string, unknown>): unknown {
  let cur: unknown = context;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function isTruthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === "string") return v.length > 0;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Objects / arrays — JSON-encode so authors get a stable, debuggable
  // representation instead of "[object Object]".
  try {
    return JSON.stringify(v);
  } catch (err) {
    return `[unstringifiable: ${toMsg(err)}]`;
  }
}

// ── Args expansion (used by the runner) ───────────────────────────────

/**
 * Recursively expand string leaves of an args object. Non-string leaves
 * (number / boolean / null / nested object / array) pass through
 * untouched — only the user's `{{...}}`-bearing strings get rendered.
 *
 * The runner uses this so authors can mix raw constants and templated
 * fields in the same `args` block:
 *
 *   { "path": "Tasks/Kanban.md", "content": "{{newKanban}}" }
 *
 * Rendering errors bubble up to the runner so the failing arg surfaces
 * with a clear message instead of getting silently coerced.
 */
export function expandArgs(args: unknown, context: Record<string, unknown>): unknown {
  if (args === null || args === undefined) return args;
  if (typeof args === "string") return renderTemplate(args, context);
  if (Array.isArray(args)) return args.map((item) => expandArgs(item, context));
  if (typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      out[k] = expandArgs(v, context);
    }
    return out;
  }
  return args;
}
