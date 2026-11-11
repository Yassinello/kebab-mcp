import { NextResponse } from "next/server";
import { resolveRegistryAsync } from "@/core/registry";
import { zodShapeToFields } from "@/core/zod-fields";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";

/**
 * GET /api/config/tool-schema?tool=<name>
 *
 * Returns a simplified JSON schema for a tool's input, derived from
 * its Zod shape. Used by the Skill Composer to generate form fields.
 *
 * GET /api/config/tool-schema (no ?tool param)
 * Returns a list of all registered tools with name + description + connector.
 */
async function getHandler(ctx: PipelineContext) {
  const { searchParams } = new URL(ctx.request.url);
  const toolName = searchParams.get("tool");

  // PERF-01: lazy resolve. Handler is already async.
  const registry = await resolveRegistryAsync();
  const enabledPacks = registry.filter((p) => p.enabled);

  // If no tool param, return list of all tools
  if (!toolName) {
    const tools: {
      name: string;
      description: string;
      connector: string;
      connectorLabel: string;
      destructive: boolean;
    }[] = [];
    for (const pack of enabledPacks) {
      for (const tool of pack.manifest.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          connector: pack.manifest.id,
          connectorLabel: pack.manifest.label,
          destructive: tool.destructive,
        });
      }
    }
    return NextResponse.json({ ok: true, tools });
  }

  // Find the specific tool
  for (const pack of enabledPacks) {
    const tool = pack.manifest.tools.find((t) => t.name === toolName);
    if (!tool) continue;

    const fields = zodShapeToFields(tool.schema);
    return NextResponse.json({
      ok: true,
      tool: toolName,
      description: tool.description,
      connector: pack.manifest.id,
      fields,
    });
  }

  return NextResponse.json({ ok: false, error: `Tool "${toolName}" not found` }, { status: 404 });
}

export const GET = withAdminAuth(getHandler);
