import { NextResponse } from "next/server";
import {
  listSkills,
  skillCreateInputSchema,
  createSkillVersioned,
} from "@/connectors/skills/store";
import { refreshNow } from "@/connectors/skills/lib/remote-fetcher";
import { getEnabledPacksLazy } from "@/core/registry";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

/** GET /api/config/skills — list all skills. */
async function getHandler() {
  try {
    const skills = await listSkills();
    return NextResponse.json({ ok: true, skills });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

/**
 * POST /api/config/skills — create a new skill.
 * Body: SkillCreateInput (name, description, content, arguments, source)
 */
async function postHandler(ctx: PipelineContext) {
  const request = ctx.request;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = skillCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid skill payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    // Reject tool-name collision against other packs.
    const newId = slugPreview(parsed.data.name);
    const collision = await findToolCollision(`skill_${newId}`);
    if (collision) {
      return NextResponse.json(
        {
          ok: false,
          error: `Tool name skill_${newId} would collide with existing tool from pack "${collision}"`,
        },
        { status: 409 }
      );
    }

    let skill = await createSkillVersioned(parsed.data);

    // If remote, do an initial fetch so the skill has content immediately.
    if (skill.source.type === "remote") {
      skill = await refreshNow(skill);
    }

    return NextResponse.json({ ok: true, skill }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function slugPreview(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "skill"
  );
}

async function findToolCollision(toolName: string): Promise<string | null> {
  // PERF-01: lazy resolve — await the async registry.
  for (const p of await getEnabledPacksLazy()) {
    if (p.manifest.id === "skills") continue;
    if (p.manifest.tools.some((t) => t.name === toolName)) return p.manifest.id;
  }
  return null;
}

export const GET = withAdminAuth(getHandler);
export const POST = withAdminAuth(postHandler);
