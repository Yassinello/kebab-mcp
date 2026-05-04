import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ConnectorManifest, ConnectorState, ToolDefinition, ToolResult } from "@/core/types";
import { runCustomTool } from "./runner";
import type { CustomTool } from "./types";

// ── Test registry ─────────────────────────────────────────────────────
//
// We mock @/core/registry so the runner sees a deterministic in-memory
// tool surface — no Vercel-style lambda gates, no env var dependencies,
// no real Slack / Vault / etc. handlers. Tests can mutate `mockTools`
// before each scenario.

const mockTools: ToolDefinition[] = [];

vi.mock("@/core/registry", () => {
  const buildManifest = (): ConnectorManifest => ({
    id: "test-connector",
    label: "Test Connector",
    description: "test",
    requiredEnvVars: [],
    tools: mockTools,
  });
  const buildState = (): ConnectorState => ({
    manifest: buildManifest(),
    enabled: true,
    reason: "active",
  });
  return {
    getEnabledPacksLazy: async () => [buildState()],
  };
});

vi.mock("@/core/credential-store", () => ({
  getHydratedCredentialSnapshot: () => ({}),
}));

// Helper to register a tool inside the mocked registry.
function registerTool(
  name: string,
  handler: (args: Record<string, unknown>) => Promise<ToolResult>,
  destructive = false
): void {
  mockTools.push({
    name,
    description: `mock ${name}`,
    schema: {},
    destructive,
    handler,
  });
}

// ── Sample tool: the kanban add ───────────────────────────────────────

function buildKanbanTool(): CustomTool {
  return {
    id: "todo_add",
    description: "Add a task to the kanban",
    destructive: true,
    inputs: [
      { name: "task", type: "string", required: true, description: "" },
      { name: "due", type: "string", required: false, description: "" },
      {
        name: "priority",
        type: "enum",
        required: false,
        values: ["high", "med", "low"],
        description: "",
      },
    ],
    steps: [
      {
        kind: "tool",
        toolName: "vault_read",
        args: { path: "Tasks/Kanban.md" },
        saveAs: "kanban",
      },
      {
        kind: "transform",
        template:
          "{{kanban}}\n- [ ] {{task}}{{#priority}} #{{priority}}{{/priority}}{{#due}} 📅 {{due}}{{/due}}",
        saveAs: "newKanban",
      },
      {
        kind: "tool",
        toolName: "vault_write",
        args: { path: "Tasks/Kanban.md", content: "{{newKanban}}" },
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("runner — happy path (todo_add → 3 steps)", () => {
  beforeEach(() => {
    mockTools.length = 0;
  });

  it("reads + transforms + writes, propagates the rendered content", async () => {
    let writtenContent = "";
    registerTool("vault_read", async () => ({
      content: [{ type: "text", text: "## Inbox\n- [ ] existing task" }],
    }));
    registerTool(
      "vault_write",
      async (args) => {
        writtenContent = String(args.content ?? "");
        return { content: [{ type: "text", text: "Wrote 1 file" }] };
      },
      true
    );

    const tool = buildKanbanTool();
    const result = await runCustomTool(tool, {
      task: "Buy milk",
      priority: "high",
      due: "2026-05-12",
    });

    expect(result.ok).toBe(true);
    expect(result.stepResults).toHaveLength(3);
    expect(result.stepResults.every((s) => s.ok)).toBe(true);
    expect(writtenContent).toBe(
      "## Inbox\n- [ ] existing task\n- [ ] Buy milk #high 📅 2026-05-12"
    );
  });

  it("omits optional fields cleanly when not provided", async () => {
    let writtenContent = "";
    registerTool("vault_read", async () => ({
      content: [{ type: "text", text: "" }],
    }));
    registerTool("vault_write", async (args) => {
      writtenContent = String(args.content ?? "");
      return { content: [{ type: "text", text: "ok" }] };
    });

    const tool = buildKanbanTool();
    const result = await runCustomTool(tool, { task: "Read book" });
    expect(result.ok).toBe(true);
    expect(writtenContent).toBe("\n- [ ] Read book");
  });

  it("rejects when required input missing", async () => {
    registerTool("vault_read", async () => ({ content: [{ type: "text", text: "" }] }));
    registerTool("vault_write", async () => ({ content: [{ type: "text", text: "ok" }] }));
    const result = await runCustomTool(buildKanbanTool(), {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/required input "task"/);
  });

  it("rejects an enum value not in the allow-list", async () => {
    registerTool("vault_read", async () => ({ content: [{ type: "text", text: "" }] }));
    registerTool("vault_write", async () => ({ content: [{ type: "text", text: "ok" }] }));
    const result = await runCustomTool(buildKanbanTool(), {
      task: "x",
      priority: "urgent",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/priority/);
  });
});

describe("runner — error surfaces", () => {
  beforeEach(() => {
    mockTools.length = 0;
  });

  it("returns a clear error when a step references an unknown tool", async () => {
    const tool: CustomTool = {
      id: "bad",
      description: "x",
      destructive: false,
      inputs: [],
      steps: [{ kind: "tool", toolName: "ghost_tool", args: {} }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ghost_tool/);
    expect(result.error).toMatch(/not registered|disabled/);
  });

  it("propagates an isError from the called tool", async () => {
    registerTool("flaky", async () => ({
      isError: true,
      content: [{ type: "text", text: "underlying boom" }],
    }));
    const tool: CustomTool = {
      id: "uses_flaky",
      description: "x",
      destructive: false,
      inputs: [],
      steps: [{ kind: "tool", toolName: "flaky", args: {} }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/underlying boom/);
    expect(result.stepResults[0]?.ok).toBe(false);
  });
});

describe("runner — recursion guard", () => {
  beforeEach(() => {
    mockTools.length = 0;
  });

  it("blocks a Custom Tool from invoking itself directly", async () => {
    // Compose: tool A's step calls tool A by name.
    const recursive: CustomTool = {
      id: "loop_a",
      description: "x",
      destructive: false,
      inputs: [],
      steps: [{ kind: "tool", toolName: "loop_a", args: {} }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Register loop_a as a fake registry tool so the lookup *would*
    // succeed if the recursion guard wasn't present. The guard must
    // intercept BEFORE the call.
    registerTool("loop_a", async () => ({
      content: [{ type: "text", text: "should never run" }],
    }));
    const result = await runCustomTool(recursive, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/recursion/i);
  });
});

describe("runner — performance overhead", () => {
  beforeEach(() => {
    mockTools.length = 0;
  });

  it("transform-only step adds < 100ms overhead", async () => {
    const tool: CustomTool = {
      id: "noop_transform",
      description: "x",
      destructive: false,
      inputs: [{ name: "x", type: "string", required: true, description: "" }],
      steps: [{ kind: "transform", template: "echo: {{x}}", saveAs: "out" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await runCustomTool(tool, { x: "hello" });
    expect(result.ok).toBe(true);
    // Generous bound — main-purpose is to catch a regression that
    // accidentally introduces sync I/O on the hot path.
    expect(result.totalDurationMs).toBeLessThan(100);
  });
});
