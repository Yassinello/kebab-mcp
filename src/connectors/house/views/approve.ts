import { renderView } from "./bridge";

/**
 * APP-11 — review of an outgoing action prepared by a send tool (preview).
 * Approval itself stays on the signed /approve page (opened with
 * ui/open-link): the view never approves on its own, so a model that can
 * call tools cannot approve through it either.
 *
 * The view is rendered per request with the origins of this Kebab House
 * (`allowedOrigins`): it only offers to open an approval link on one of
 * them, and shows that origin so the user recognises their own page.
 * Preview fields that are objects or arrays (a WhatsApp chat, a LinkedIn
 * recipient) are rendered as readable text instead of being skipped.
 */
export function approveView(allowedOrigins: readonly string[]): string {
  // Origins are URL.origin values; escape "<" anyway so the JSON can never
  // close the <script> element it is embedded in.
  const origins = JSON.stringify([...new Set(allowedOrigins.filter(Boolean))]).replace(
    /</g,
    "\\u003c"
  );
  return renderView(
    "Review before sending",
    `<h1>Review before sending</h1>
<div id="root" class="muted">Waiting for the preview…</div>`,
    `
const ALLOWED_ORIGINS = ${origins};
const root = document.getElementById("root");
const NAME_KEYS = ["display_name", "displayName", "name", "full_name", "title", "subject", "username", "handle"];
const CONTACT_KEYS = ["email", "phone", "phone_number", "public_identifier", "provider_id", "id"];
const ACCOUNT_NAME_KEYS = ["account_display_name", "account_name", "account_label"];
const label = (k) => { const s = String(k).replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };
// Readable text for any preview value (strings, numbers, objects, arrays).
function fmt(v, depth) {
  depth = depth || 0;
  if (v === null || v === undefined || v === "") return "";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map((x) => fmt(x, depth + 1)).filter(Boolean).join(", ");
  const name = NAME_KEYS.map((k) => v[k]).find((x) => typeof x === "string" && x.trim());
  const contact = CONTACT_KEYS.map((k) => v[k]).find((x) => (typeof x === "string" && x.trim()) || typeof x === "number");
  if (name) return contact !== undefined && String(contact) !== name ? name + " (" + contact + ")" : name;
  if (depth > 1) return JSON.stringify(v);
  return Object.keys(v)
    .map((k) => { const s = fmt(v[k], depth + 1); return s ? label(k) + ": " + s : ""; })
    .filter(Boolean)
    .join("; ");
}
function originOf(u) { try { return new URL(u).origin; } catch { return null; } }
function accountName(d, p) {
  for (const src of [d, p]) {
    for (const k of ACCOUNT_NAME_KEYS) if (typeof src[k] === "string" && src[k].trim()) return src[k];
  }
  return p.account && typeof p.account === "object" ? fmt(p.account) : null;
}
function row(card, k, v) {
  const s = fmt(v);
  if (!s) return;
  if (s.length > 80 || s.includes("\\n")) { card.append(kh.el("h2", k)); card.append(kh.el("pre", s)); }
  else { const r = kh.el("div", undefined, "row"); r.append(kh.el("span", k, "muted"), kh.el("span", s)); card.append(r); }
}
kh.onResult((res) => {
  const d = kh.data(res) || {};
  root.textContent = ""; root.className = "";
  const p = d.preview && typeof d.preview === "object" ? d.preview : {};
  if (!d.approval_url) {
    root.append(kh.el("p", d.executed ? "Sent." : (d.error ? "Not sent: " + d.error : "Nothing to approve."), "muted"));
    return;
  }
  const card = kh.el("div", undefined, "card");
  const account = accountName(d, p);
  if (account) row(card, "From", account);
  Object.keys(p).forEach((k) => {
    if (ACCOUNT_NAME_KEYS.includes(k) || (account && k === "account")) return;
    row(card, label(k), p[k]);
  });
  root.append(card);
  const origin = originOf(d.approval_url);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    root.append(kh.el("p", "This approval link does not point to your Kebab House" + (origin ? " (" + origin + ")" : "") + ", so it is not offered here. Nothing was sent.", "muted"));
    return;
  }
  root.append(kh.el("p", "Nothing is sent until you approve it on your Kebab House: " + origin, "muted"));
  const b = kh.el("button", "Open the approval page", "primary");
  b.onclick = () => kh.openLink(d.approval_url).catch(() => {});
  root.append(b);
});
`
  );
}
