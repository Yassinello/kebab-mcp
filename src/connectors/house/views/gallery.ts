import { renderView } from "./bridge";

/** APP-12 — skills gallery: search, use a skill, install ritual templates. */
export const GALLERY_VIEW = renderView(
  "Your skills",
  `<h1>Your skills</h1>
<input id="q" placeholder="Search skills…" aria-label="Search skills">
<div id="skills"></div>
<h2>Ritual templates</h2>
<div id="templates" class="muted">Loading…</div>`,
  `
let data = null;
const q = document.getElementById("q");
const skillsEl = document.getElementById("skills");
const tplEl = document.getElementById("templates");
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
function render() {
  if (!data) return;
  const term = norm(q.value);
  skillsEl.textContent = "";
  const list = data.skills.filter((s) => !term || norm(s.name + " " + s.description + " " + (s.tags || []).join(" ")).includes(term));
  if (!list.length) skillsEl.append(kh.el("p", data.skills.length ? "No skill matches." : "No skill yet.", "muted"));
  list.forEach((s) => {
    const c = kh.el("div", undefined, "card");
    c.append(kh.el("strong", s.title || s.name));
    c.append(kh.el("div", s.description, "muted"));
    const tags = kh.el("div"); (s.tags || []).forEach((t) => tags.append(kh.el("span", "#" + t, "chip"))); c.append(tags);
    const b = kh.el("button", "Use this skill", "primary");
    b.onclick = () => kh.sendMessage("Use my skill " + s.name + ".").catch(() => {});
    c.append(b);
    skillsEl.append(c);
  });
  tplEl.textContent = ""; tplEl.className = "";
  data.templates.forEach((t) => {
    const r = kh.el("div", undefined, "row");
    r.append(kh.el("span", t.title + " — " + t.status));
    if (t.status !== "installed") {
      const b = kh.el("button", t.status === "modified" ? "Update" : "Install");
      b.onclick = async () => {
        b.disabled = true;
        try {
          const res = await kh.callTool("skill_template_install", { name: t.name });
          b.textContent = res && res.isError ? "Not allowed here" : "Installed";
        } catch { b.textContent = "Failed"; }
      };
      r.append(b);
    }
    tplEl.append(r);
  });
}
q.addEventListener("input", render);
kh.onResult((res) => { data = kh.data(res) || { skills: [], templates: [] }; render(); });
`
);
