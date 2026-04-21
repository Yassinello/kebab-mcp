import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { resolveRegistry } from "@/core/registry";
import type { z } from "zod";
import { withBootstrapRehydrate } from "@/core/with-bootstrap-rehydrate";

/**
 * GET /api/config/tool-schema?tool=<name>
 *
 * Returns a simplified JSON schema for a tool's input, derived from
 * its Zod shape. Used by the Skill Composer to generate form fields.
 *
 * GET /api/config/tool-schema (no ?tool param)
 * Returns a list of all registered tools with name + description + connector.
 */
async function getHandler(request: Request) {
  const authError = await checkAdminAuth(request);
  if (authError) return authError;

  const { searchParams } = new URL(request.url);
  const toolName = searchParams.get("tool");

  const registry = resolveRegistry();
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

// ── Zod shape → simple field descriptors ──────────────────────────────

interface FieldDescriptor {
  name: string;
  type: "string" | "number" | "boolean" | "enum" | "unknown";
  description: string;
  required: boolean;
  enumValues?: string[];
  default?: unknown;
}

/**
 * Convert a ZodRawShape (Record<string, ZodTypeAny>) into an array of
 * simple field descriptors the frontend can render as form inputs.
 *
 * Handles: z.string(), z.number(), z.boolean(), z.enum([...]),
 * z.optional(...), z.default(...), z.describe(...).
 *
 * Zod v4 uses `_zod.def.type` as the discriminant instead of
 * traditional `instanceof` checks for wrapper types.
 */
function zodShapeToFields(shape: z.ZodRawShape): FieldDescriptor[] {
  const fields: FieldDescriptor[] = [];

  for (const [name, zodType] of Object.entries(shape)) {
    fields.push(unwrapZodType(name, zodType as unknown as z.ZodTypeAny));
  }

  return fields;
}

/** Access Zod v4 internal def safely */
function getZodDef(t: z.ZodTypeAny): Record<string, unknown> {
  // Zod v4: internals are on `_zod.def`
  const zod = (t as unknown as { _zod?: { def?: Record<string, unknown> } })._zod;
  return zod?.def ?? {};
}

/** Get the Zod v4 type discriminant string */
function getZodType(t: z.ZodTypeAny): string {
  const def = getZodDef(t);
  return typeof def.type === "string" ? def.type : "";
}

function unwrapZodType(name: string, zodType: z.ZodTypeAny): FieldDescriptor {
  let current: z.ZodTypeAny = zodType;
  let required = true;
  let description = "";
  let defaultValue: unknown = undefined;

  // Peel away wrappers: optional, default, pipe
  for (let depth = 0; depth < 10; depth++) {
    // Extract description at each level
    if (current.description) {
      description = current.description;
    }

    const typeName = getZodType(current);

    if (typeName === "optional") {
      required = false;
      const def = getZodDef(current);
      current = def.innerType as z.ZodTypeAny;
      if (!current) break;
    } else if (typeName === "default") {
      required = false;
      const def = getZodDef(current);
      defaultValue = def.defaultValue;
      current = def.innerType as z.ZodTypeAny;
      if (!current) break;
    } else if (typeName === "pipe") {
      const def = getZodDef(current);
      current = (def.in ?? def.from) as z.ZodTypeAny;
      if (!current) break;
    } else {
      break;
    }
  }

  // Identify the base type
  const baseType = getZodType(current);

  if (baseType === "string") {
    return { name, type: "string", description, required, default: defaultValue };
  }
  if (baseType === "number" || baseType === "int" || baseType === "float") {
    return { name, type: "number", description, required, default: defaultValue };
  }
  if (baseType === "boolean") {
    return { name, type: "boolean", description, required, default: defaultValue };
  }
  if (baseType === "enum") {
    // Zod v4: enum values are in _zod.def.entries (Record<string,string>) or .options (string[])
    const opts = (current as unknown as { options?: string[] }).options;
    const enumValues = Array.isArray(opts) ? opts : [];
    return { name, type: "enum", description, required, enumValues, default: defaultValue };
  }
  if (baseType === "literal") {
    const def = getZodDef(current);
    const values = def.values;
    if (Array.isArray(values) && values.length > 0 && typeof values[0] === "string") {
      return {
        name,
        type: "enum",
        description,
        required,
        enumValues: values as string[],
        default: defaultValue,
      };
    }
  }

  return { name, type: "unknown", description, required, default: defaultValue };
}

export const GET = withBootstrapRehydrate(getHandler);
