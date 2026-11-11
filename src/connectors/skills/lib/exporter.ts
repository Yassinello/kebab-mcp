/**
 * Skills v2 — exports (spec §7): one skill, its relay, or the whole
 * (scoped) library, as Agent Skills zips.
 */

import { isSkillVisible } from "@/core/token-scope";
import { getSkillFiles, listSkills, type Skill } from "../store";
import { buildSkillsZip, relaySkillMd, toAgentName } from "./bundle";
import { skillMdFor } from "./library";

/** Root manifest used by the native-sync one-liner to prune removed skills. */
export const LIBRARY_MANIFEST = ".kebab-skills.json";

export async function exportSkillZip(skill: Skill): Promise<Uint8Array> {
  return buildSkillsZip([
    {
      name: toAgentName(skill.id),
      skillMd: skillMdFor(skill),
      files: await getSkillFiles(skill.id),
    },
  ]);
}

export function exportRelayZip(skill: Skill): Uint8Array {
  const name = toAgentName(skill.id);
  return buildSkillsZip([
    { name, skillMd: relaySkillMd(name, skill.description || skill.name), files: {} },
  ]);
}

export async function exportLibraryZip(
  scope: string[] | null
): Promise<{ zip: Uint8Array; count: number }> {
  const skills = (await listSkills())
    .filter((s) => isSkillVisible(s.tags ?? [], scope))
    .sort((a, b) => a.id.localeCompare(b.id));
  const entries = [];
  for (const s of skills) {
    entries.push({
      name: toAgentName(s.id),
      skillMd: skillMdFor(s),
      files: await getSkillFiles(s.id),
    });
  }
  const manifest = JSON.stringify(
    {
      source: "kebab-mcp",
      exportedAt: new Date().toISOString(),
      skills: entries.map((e) => e.name),
    },
    null,
    2
  );
  return { zip: buildSkillsZip(entries, { [LIBRARY_MANIFEST]: manifest }), count: entries.length };
}

export function zipResponse(
  zip: Uint8Array,
  filename: string,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(Buffer.from(zip), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
