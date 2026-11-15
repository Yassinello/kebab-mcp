import { renderView } from "./bridge";

/**
 * APP-11 — review of an outgoing action prepared by a send tool (preview).
 * Approval itself stays on the signed /approve page (opened with
 * ui/open-link): the view never approves on its own, so a model that can
 * call tools cannot approve through it either.
 */
export const APPROVE_VIEW = renderView(
  "Review before sending",
  `<h1>Review before sending</h1>
<div id="root" class="muted">Waiting for the preview…</div>`,
  `
const root = document.getElementById("root");
kh.onResult((res) => {
  const d = kh.data(res) || {};
  root.textContent = ""; root.className = "";
  const p = d.preview || {};
  if (!d.approval_url) {
    root.append(kh.el("p", d.executed ? "Sent." : (d.error ? "Not sent: " + d.error : "Nothing to approve."), "muted"));
    return;
  }
  const card = kh.el("div", undefined, "card");
  Object.keys(p).forEach((k) => {
    const v = p[k];
    if (v === null || v === undefined || typeof v === "object") return;
    const long = String(v).length > 80;
    if (long) { card.append(kh.el("h2", k)); card.append(kh.el("pre", v)); }
    else { const r = kh.el("div", undefined, "row"); r.append(kh.el("span", k, "muted"), kh.el("span", v)); card.append(r); }
  });
  root.append(card);
  root.append(kh.el("p", "Nothing is sent until you approve it in your Kebab House.", "muted"));
  const b = kh.el("button", "Open the approval page", "primary");
  b.onclick = () => kh.openLink(d.approval_url).catch(() => {});
  root.append(b);
});
`
);
