import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCustomTool,
  listCustomTools,
  getCustomTool,
  updateCustomTool,
  deleteCustomTool,
  primeCustomToolsCache,
  listCustomToolsSync,
  _resetCustomToolsCacheForTests,
  _resetKnownToolFactsCacheForTests,
} from "./store";
import { resetKVStoreCache } from "@/core/kv-store";

describe("custom-tools store CRUD", () => {
  let tmp: string;
  const prevKv = process.env["MYMCP_KV_PATH"];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-custom-tools-store-"));
    process.env["MYMCP_KV_PATH"] = path.join(tmp, "kv.json");
    resetKVStoreCache();
    _resetCustomToolsCacheForTests();
    _resetKnownToolFactsCacheForTests();
  });

  afterEach(async () => {
    if (prevKv === undefined) delete process.env["MYMCP_KV_PATH"];
    else process.env["MYMCP_KV_PATH"] = prevKv;
    resetKVStoreCache();
    _resetCustomToolsCacheForTests();
    _resetKnownToolFactsCacheForTests();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const baseTool = {
    id: "todo_add",
    description: "Add a task",
    destructive: true,
    inputs: [
      {
        name: "task",
        type: "string" as const,
        required: true,
        description: "The task description",
      },
    ],
    steps: [{ kind: "transform" as const, template: "- [ ] {{task}}", saveAs: "line" }],
  };

  it("creates and lists tools", async () => {
    const t = await createCustomTool(baseTool);
    expect(t.id).toBe("todo_add");
    expect(t.createdAt).toBeTruthy();
    expect(t.updatedAt).toBeTruthy();

    const all = await listCustomTools();
    expect(all).toHaveLength(1);
    expect(await getCustomTool("todo_add")).toMatchObject({ id: "todo_add" });
  });

  it("rejects duplicate id on create", async () => {
    await createCustomTool(baseTool);
    await expect(createCustomTool(baseTool)).rejects.toThrow(/already exists/i);
  });

  it("rejects malformed templates at write time (Mustache validation)", async () => {
    await expect(
      createCustomTool({
        ...baseTool,
        id: "bad_tool",
        steps: [{ kind: "transform", template: "{{#open}}no close", saveAs: "out" }],
      })
    ).rejects.toThrow(/template invalid|unclosed/i);
  });

  it("validates string-leaf templates inside tool args", async () => {
    await expect(
      createCustomTool({
        ...baseTool,
        id: "bad_args",
        steps: [
          {
            kind: "tool",
            toolName: "vault_read",
            args: { path: "Tasks/{{1bad}}.md" },
          },
        ],
      })
    ).rejects.toThrow(/template invalid|invalid path segment/i);
  });

  it("updates description + steps but rejects id renames", async () => {
    await createCustomTool(baseTool);
    const updated = await updateCustomTool("todo_add", {
      ...baseTool,
      description: "Add a task — updated",
    });
    expect(updated?.description).toBe("Add a task — updated");

    await expect(updateCustomTool("todo_add", { ...baseTool, id: "renamed" })).rejects.toThrow(
      /immutable/i
    );
  });

  it("delete returns true once + false on second call", async () => {
    await createCustomTool(baseTool);
    expect(await deleteCustomTool("todo_add")).toBe(true);
    expect(await deleteCustomTool("todo_add")).toBe(false);
  });

  it("primeCustomToolsCache populates the sync getter", async () => {
    await createCustomTool(baseTool);
    _resetCustomToolsCacheForTests();
    expect(listCustomToolsSync()).toHaveLength(0);
    await primeCustomToolsCache();
    expect(listCustomToolsSync()).toHaveLength(1);
  });

  // HI-02 — toolName referenced by a step must exist + be allowlisted at
  // write time (instead of failing later at first invocation).
  it("rejects a write that references an unknown toolName", async () => {
    await expect(
      createCustomTool({
        ...baseTool,
        id: "bad_ref",
        steps: [{ kind: "tool", toolName: "definitely_not_a_tool", args: {} }],
      })
    ).rejects.toThrow(/definitely_not_a_tool/);
  });

  // HI-03 — destructive must aggregate from composed steps. A tool that
  // calls `vault_write` (destructive in the real registry) but sets
  // `destructive: false` at the top level should still surface as
  // destructive on the stored CustomTool, so MCP clients that gate on
  // the flag (claude.ai, cline) ask for confirmation.
  it("force-sets destructive when a step calls a destructive tool", async () => {
    const tool = await createCustomTool({
      ...baseTool,
      id: "writes_vault",
      destructive: false, // user lied (or forgot)
      steps: [
        { kind: "transform", template: "hello", saveAs: "body" },
        {
          kind: "tool",
          toolName: "vault_write",
          args: { path: "Notes/test.md", content: "{{body}}" },
        },
      ],
    });
    expect(tool.destructive).toBe(true);
  });
});
