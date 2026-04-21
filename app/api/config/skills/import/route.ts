import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { parseFrontmatter } from "@/core/frontmatter";
import { fetchRemote } from "@/connectors/skills/lib/remote-fetcher";
import { createSkill } from "@/connectors/skills/store";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * POST /api/config/skills/import
 *
 * Two actions:
 * - { url, action: "preview" } → fetch + parse, return preview without saving
 * - { url, action: "save" }    → fetch + parse + persist as a remote skill
 *
 * Frontmatter is parsed by src/core/frontmatter.ts (js-yaml backed).
 * Full YAML is supported including multiline block scalars, nested maps,
 * and quoted values. Falls back to inferring name from URL filename when
 * frontmatter is missing.
 */

interface ParsedSkill {
  name: string;
  description: string;
  content: string;
  arguments: { name: string; description?: string; required?: boolean }[];
}

interface FrontmatterArg {
  name?: unknown;
  description?: unknown;
  required?: unknown;
}

function inferNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.split("/").filter(Boolean);
    const last = path[path.length - 1] || "imported-skill";
    return last
      .replace(/\.(md|markdown|txt)$/i, "")
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase();
  } catch {
    return "imported-skill";
  }
}

function buildSkillFromContent(
  url: string,
  content: string
): { skill: ParsedSkill; warnings: string[] } {
  const { meta, body, warnings } = parseFrontmatter(content);

  const name =
    typeof meta.name === "string" && meta.name.trim()
      ? (meta.name as string).trim()
      : inferNameFromUrl(url);
  const description =
    typeof meta.description === "string" ? (meta.description as string).trim() : "";

  const args: { name: string; description?: string; required?: boolean }[] = [];
  if (Array.isArray(meta.arguments)) {
    for (const a of meta.arguments as FrontmatterArg[]) {
      if (a && typeof a === "object" && typeof a.name === "string") {
        args.push({
          name: a.name,
          description: typeof a.description === "string" ? a.description : undefined,
          required: a.required === true,
        });
      }
    }
  } else if (meta.arguments) {
    warnings.push("`arguments` field present but not in expected list format — ignored");
  }

  return {
    skill: {
      name,
      description,
      content: body.trim(),
      arguments: args,
    },
    warnings,
  };
}

async function postHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  let body: { url?: string; action?: "preview" | "save" };
  try {
    body = (await request.json()) as { url?: string; action?: "preview" | "save" };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const url = body.url?.trim();
  const action = body.action || "preview";
  if (!url) {
    return NextResponse.json({ ok: false, error: "Missing url" }, { status: 400 });
  }

  // fetchRemote enforces https-only, SSRF protection, byte cap, timeout.
  const fetched = await fetchRemote(url);
  if (!fetched.ok || !fetched.content) {
    return NextResponse.json({ ok: false, error: fetched.error || "Fetch failed" });
  }

  const { skill, warnings } = buildSkillFromContent(url, fetched.content);

  if (action === "preview") {
    return NextResponse.json({ ok: true, skill, warnings });
  }

  // action === "save"
  if (!skill.name || skill.name.length < 1) {
    return NextResponse.json({ ok: false, error: "Could not infer a skill name" }, { status: 400 });
  }

  try {
    const created = await createSkill({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      arguments: skill.arguments.map((a) => ({
        name: a.name,
        description: a.description ?? "",
        required: a.required ?? false,
      })),
      source: {
        type: "remote",
        url,
        cachedContent: fetched.content,
        cachedAt: new Date().toISOString(),
      },
    });
    return NextResponse.json({ ok: true, id: created.id });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Save failed",
    });
  }
}

export const POST = withBootstrapRehydrate(postHandler);
