import type { Skill } from "../store";

/**
 * Mustache-lite argument injection.
 *
 * Replaces {{argName}} in content with the provided value.
 * For any argument that was NOT referenced via a placeholder but was passed
 * at call time, append it at the end as `**name**: value`.
 */
export function renderSkill(skill: Skill, args: Record<string, unknown>): string {
  // For remote skills, use cached content if source content is empty.
  let content = skill.content;
  if ((!content || content.length === 0) && skill.source.type === "remote") {
    content = skill.source.cachedContent ?? "";
  }

  const used = new Set<string>();

  const rendered = content.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, name) => {
    if (name in args) {
      used.add(name);
      return String(args[name] ?? "");
    }
    return "";
  });

  const tail: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (used.has(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    tail.push(`**${k}**: ${String(v)}`);
  }

  if (tail.length === 0) return rendered;
  return `${rendered}\n\n${tail.join("\n")}`;
}
