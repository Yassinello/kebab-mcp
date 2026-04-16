/**
 * Export a MyMCP skill to Claude Desktop `.skill` format.
 *
 * Claude Skill format is a JSON file with extension `.skill`:
 * ```json
 * {
 *   "name": "Skill Name",
 *   "description": "What this skill does",
 *   "content": "The full prompt/instruction text",
 *   "metadata": {
 *     "source": "mymcp",
 *     "version": "1.0",
 *     "exportedAt": "ISO timestamp"
 *   }
 * }
 * ```
 */

export interface ClaudeSkillFile {
  name: string;
  description: string;
  content: string;
  metadata: {
    source: "mymcp";
    version: string;
    exportedAt: string;
  };
}

/**
 * Minimal skill shape needed for conversion — avoids coupling to the
 * full Skill type so the function works on both server and client.
 */
export interface SkillLike {
  name: string;
  description: string;
  content: string;
  source?: { type: string; cachedContent?: string };
}

/**
 * Convert a MyMCP skill to Claude Desktop `.skill` JSON format.
 *
 * @param skill  The skill (or skill-like object) to convert.
 * @param opts   Optional overrides for metadata fields.
 * @returns      A ClaudeSkillFile object ready to be JSON.stringify'd.
 */
export function toClaudeSkillFile(
  skill: SkillLike,
  opts?: { version?: string; exportedAt?: string }
): ClaudeSkillFile {
  // For remote skills, prefer cached content when the primary content is empty.
  const body =
    skill.content || (skill.source?.type === "remote" ? skill.source.cachedContent || "" : "");

  return {
    name: skill.name,
    description: skill.description || skill.name,
    content: body,
    metadata: {
      source: "mymcp",
      version: opts?.version ?? "1.0",
      exportedAt: opts?.exportedAt ?? new Date().toISOString(),
    },
  };
}
