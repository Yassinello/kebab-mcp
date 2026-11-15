import { renderView } from "./bridge";

/** APP-10 — state of the hub: profile, skills, recent notes, connectors, this week. */
export const STATUS_VIEW = renderView(
  "Kebab House",
  `<h1>Kebab House</h1>
<div id="root" class="muted">Loading…</div>`,
  `
const root = document.getElementById("root");
kh.onResult((res) => {
  const d = kh.data(res);
  root.textContent = "";
  root.className = "";
  if (!d) { root.textContent = "No data."; return; }
  const top = kh.el("div", undefined, "grid");
  const stat = (value, label) => { const c = kh.el("div", undefined, "card"); c.append(kh.el("div", value, "big"), kh.el("div", label, "muted")); return c; };
  top.append(stat(d.week.total, "tool calls this week"), stat(d.week.notes, "notes added"), stat(d.skills.count, "skills"), stat(d.connectors.length, "connectors"));
  root.append(top);
  root.append(kh.el("h2", "Profile · " + d.profile.name));
  root.append(kh.el("pre", d.profile.preview || "No profile yet — say “Set up my Kebab House”."));
  if (d.week.skills.length) {
    root.append(kh.el("h2", "Most used skills this week"));
    d.week.skills.slice(0, 5).forEach((s) => { const r = kh.el("div", undefined, "row"); r.append(kh.el("span", s.name), kh.el("span", s.count, "muted")); root.append(r); });
  }
  if (d.notes && d.notes.length) {
    root.append(kh.el("h2", "Recent notes"));
    d.notes.forEach((n) => { const r = kh.el("div", undefined, "row"); r.append(kh.el("span", n.path), kh.el("span", (n.date || "").slice(0, 10), "muted")); root.append(r); });
  }
  root.append(kh.el("h2", "Connectors"));
  const chips = kh.el("div");
  d.connectors.forEach((c) => chips.append(kh.el("span", c, "chip")));
  root.append(chips);
});
`
);
