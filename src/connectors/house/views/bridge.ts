/**
 * Kebab House phase 3 (APP-01/03) — shared pieces of the MCP Apps views.
 *
 * Each view is a self-contained HTML document (no external script, style,
 * font or network call) rendered by the host in a sandboxed iframe. It talks
 * to the host with JSON-RPC 2.0 over postMessage, as the MCP Apps extension
 * (`io.modelcontextprotocol/ui`) specifies: `ui/initialize`, then
 * `ui/notifications/initialized`; the host pushes the tool result with
 * `ui/notifications/tool-result`; the view may call `tools/call`,
 * `ui/message` and `ui/open-link`, and reports its height with
 * `ui/notifications/size-changed`.
 *
 * Data is always inserted with textContent (never innerHTML), so content
 * coming from tools cannot inject markup into the view.
 */

export const UI_MIME_TYPE = "text/html;profile=mcp-app";
export const UI_PROTOCOL_VERSION = "2026-01-26";
export const UI_SCHEME = "ui";
export const UI_URI_PREFIX = "ui://kebab-house/";

/** `_meta` for a tool rendered by a view (both the nested and the flat key, for host compatibility). */
export function uiToolMeta(view: string, visibility?: ("model" | "app")[]) {
  const resourceUri = `${UI_URI_PREFIX}${view}`;
  return {
    ui: { resourceUri, ...(visibility ? { visibility } : {}) },
    "ui/resourceUri": resourceUri,
  };
}

const BRIDGE_JS = `
(() => {
  const pending = new Map();
  let seq = 0;
  const post = (m) => window.parent.postMessage(m, "*");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      post({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error("timeout: " + method)); }
      }, 30000);
    });
  const notify = (method, params) => post({ jsonrpc: "2.0", method, params: params || {} });
  const listeners = [];
  window.addEventListener("message", (e) => {
    // Only the host (our parent frame) speaks the protocol: ignore messages
    // from any other window (another frame, a popup).
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && pending.has(m.id) && !m.method) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || "error")); else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-result") listeners.forEach((f) => f(m.params || {}));
    if (m.method === "ui/notifications/host-context-changed") applyTheme(m.params || {});
  });
  function applyTheme(ctx) {
    if (ctx && ctx.theme) document.documentElement.dataset.theme = ctx.theme;
  }
  const kh = {
    onResult: (f) => listeners.push(f),
    callTool: (name, args) => request("tools/call", { name, arguments: args || {} }),
    sendMessage: (text) => request("ui/message", { role: "user", content: [{ type: "text", text }] }),
    openLink: (url) => request("ui/open-link", { url }),
    // The structured payload of a tool result: structuredContent when the tool
    // sets it, else the JSON text most tools return.
    data: (res) => {
      if (res && res.structuredContent) return res.structuredContent;
      const t = res && res.content && res.content[0] && res.content[0].text;
      try { return JSON.parse(t); } catch { return null; }
    },
    el: (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n; },
  };
  window.kh = kh;
  new ResizeObserver(() => notify("ui/notifications/size-changed", { height: document.documentElement.scrollHeight })).observe(document.body);
  request("ui/initialize", { appInfo: { name: "kebab-house", version: "1" }, appCapabilities: {}, protocolVersion: "${UI_PROTOCOL_VERSION}" })
    .then((r) => { applyTheme((r && r.hostContext) || {}); notify("ui/notifications/initialized"); })
    .catch(() => notify("ui/notifications/initialized"));
})();
`;

const BASE_CSS = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1c1c1c; --muted: #6b7280; --border: #e5e5e0; --accent: #d97706; --chip: #f5f5f0; }
:root[data-theme="dark"] { --bg: #141414; --fg: #f5f5f0; --muted: #9ca3af; --border: #2a2a26; --chip: #1f1f1c; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #141414; --fg: #f5f5f0; --muted: #9ca3af; --border: #2a2a26; --chip: #1f1f1c; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 14px 16px; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); }
h1 { font-size: 15px; margin: 0 0 10px; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 14px 0 6px; font-weight: 600; }
.muted { color: var(--muted); }
.row { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--border); }
.chip { display: inline-block; background: var(--chip); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; font-size: 12px; margin: 2px 4px 2px 0; }
.card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 8px 0; }
button { font: inherit; font-size: 13px; border-radius: 8px; border: 1px solid var(--border); background: var(--chip); color: var(--fg); padding: 5px 10px; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: .55; cursor: default; }
input { font: inherit; width: 100%; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); }
pre { white-space: pre-wrap; word-break: break-word; background: var(--chip); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin: 6px 0; font-size: 13px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
.big { font-size: 22px; font-weight: 700; }
`;

/** Wrap a view body + script into a complete, self-contained HTML document. */
export function renderView(title: string, bodyHtml: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${BASE_CSS}</style>
</head>
<body>
${bodyHtml}
<script>${BRIDGE_JS}</script>
<script>${script}</script>
</body>
</html>`;
}
