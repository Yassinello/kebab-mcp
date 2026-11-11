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
  cleanupOrphanTestTools,
  _resetCustomToolsCacheForTests,
  _resetKnownToolFactsCacheForTests,
} from "./store";
import { getContextKVStore } from "@/core/request-context";
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

  // Phase 2 — estimatedCost is stamped server-side and surfaces the
  // coarse cost-per-pack heuristic. Transform-only tools cost 0.
  it("stamps estimatedCost = 0 on a transform-only tool", async () => {
    const tool = await createCustomTool(baseTool); // single transform step
    expect(tool.estimatedCost).toBe(0);
  });

  // Phase 2 — write-time cost cap. A tool with too many expensive
  // steps must be refused with a message that names the offending
  // estimate AND the cap, so the dashboard can show authors how to
  // remediate.
  it("rejects a write whose estimated cost exceeds MAX_COST_PER_RUN", async () => {
    // 6× web_agent → 60 points (cap is 50). Use a known browser tool
    // name; even if the registry refuses it because BROWSERBASE_*
    // env vars aren't set in the test, the toolName allowlist still
    // recognises it via the disabled-manifest force-load (see
    // buildKnownToolFacts).
    await expect(
      createCustomTool({
        ...baseTool,
        id: "too_expensive",
        steps: [
          { kind: "tool", toolName: "web_agent", args: {} },
          { kind: "tool", toolName: "web_agent", args: {} },
          { kind: "tool", toolName: "web_agent", args: {} },
          { kind: "tool", toolName: "web_agent", args: {} },
          { kind: "tool", toolName: "web_agent", args: {} },
          { kind: "tool", toolName: "web_agent", args: {} },
        ],
      })
    ).rejects.toThrow(/estimated cost \d+ exceeds limit \d+/i);
  });

  // ── Bonus C — cross-step variable validation at write time ──────────

  it("rejects a write whose transform references a variable not in inputs and not produced by an earlier step", async () => {
    await expect(
      createCustomTool({
        ...baseTool,
        id: "typo_var",
        // input is `task`, the template references `taks` (typo)
        steps: [{ kind: "transform", template: "- [ ] {{taks}}", saveAs: "line" }],
      })
    ).rejects.toThrow(/unknown variable 'taks'.*not in inputs/i);
  });

  it("rejects when step 2 references a variable that step 1 forgot to saveAs", async () => {
    await expect(
      createCustomTool({
        ...baseTool,
        id: "missing_saveas",
        steps: [
          // step 0 transforms but does not save — `intermediate` is never in availableNames
          { kind: "transform", template: "hello {{task}}", saveAs: "intermediate_typo" },
          // step 1 references the wrong name
          { kind: "transform", template: "wrap[{{intermediate}}]", saveAs: "out" },
        ],
      })
    ).rejects.toThrow(/step\[1\].*unknown variable 'intermediate'/i);
  });

  it("accepts dotted-access on a known root (we only check the root segment)", async () => {
    // The runner resolves `{{user.name}}` against whatever `user` is —
    // we can't know the shape at write time, but the ROOT must be
    // declared. As long as `user` is in inputs, dotted access passes.
    const tool = await createCustomTool({
      ...baseTool,
      id: "dotted_ok",
      inputs: [{ name: "user", type: "string", required: true, description: "" }],
      steps: [{ kind: "transform", template: "hi {{user.name}}", saveAs: "line" }],
    });
    expect(tool.id).toBe("dotted_ok");
  });

  it("accepts a saveAs reference as input to the next step", async () => {
    const tool = await createCustomTool({
      ...baseTool,
      id: "chain_ok",
      inputs: [{ name: "task", type: "string", required: true, description: "" }],
      steps: [
        { kind: "transform", template: "- [ ] {{task}}", saveAs: "line" },
        { kind: "transform", template: "Wrapped: {{line}}", saveAs: "out" },
      ],
    });
    expect(tool.id).toBe("chain_ok");
  });

  it("validates root-var references inside templated tool-step args", async () => {
    await expect(
      createCustomTool({
        ...baseTool,
        id: "tool_arg_typo",
        inputs: [{ name: "name", type: "string", required: true, description: "" }],
        steps: [
          {
            kind: "tool",
            toolName: "vault_read",
            args: { path: "Notes/{{nmae}}.md" }, // typo: nmae
          },
        ],
      })
    ).rejects.toThrow(/unknown variable 'nmae'/i);
  });

  // ── Bonus A — orphan cleanup of t__test_* tools ─────────────────────

  it("cleanupOrphanTestTools deletes test tools older than 5 minutes", async () => {
    // Stage one fresh test tool (NOT an orphan) and one ancient one.
    // The store doesn't expose a "set createdAt" knob, so we write the
    // KV array directly to plant an old timestamp in the id suffix.
    const sixMinAgo = Date.now() - 6 * 60 * 1000;
    const oldId = `t__test_old_${sixMinAgo.toString(36)}`;
    const recentId = `t__test_recent_${Date.now().toString(36)}`;

    await createCustomTool({ ...baseTool, id: oldId });
    await createCustomTool({ ...baseTool, id: recentId });
    // Sanity — both present.
    expect((await listCustomTools()).map((t) => t.id).sort()).toEqual([oldId, recentId].sort());

    const { deleted } = await cleanupOrphanTestTools();
    expect(deleted).toBe(1);
    const remaining = await listCustomTools();
    expect(remaining.map((t) => t.id)).toEqual([recentId]);
  });

  it("cleanupOrphanTestTools deletes test tools whose suffix can't be parsed as a timestamp", async () => {
    // No underscore-separated timestamp at all, AND id matches `^[a-z][a-z0-9_]{0,63}$`
    // since lowercase + digits + underscore are allowed by customToolIdPattern.
    const malformedId = "t__test_no_timestamp_at_all";
    await createCustomTool({ ...baseTool, id: malformedId });
    const { deleted } = await cleanupOrphanTestTools();
    expect(deleted).toBeGreaterThanOrEqual(1);
    const ids = (await listCustomTools()).map((t) => t.id);
    expect(ids).not.toContain(malformedId);
  });

  it("cleanupOrphanTestTools leaves real (non-prefixed) tools alone", async () => {
    await createCustomTool(baseTool); // id: todo_add — no t__test_ prefix
    const { deleted } = await cleanupOrphanTestTools();
    expect(deleted).toBe(0);
    expect((await listCustomTools()).map((t) => t.id)).toContain("todo_add");
  });

  it("cleanupOrphanTestTools also drops version history for swept ids", async () => {
    const sixMinAgo = Date.now() - 6 * 60 * 1000;
    const oldId = `t__test_versioned_${sixMinAgo.toString(36)}`;
    await createCustomTool({ ...baseTool, id: oldId });
    // Update once to force a version-history entry (pushVersion).
    await updateCustomTool(oldId, { ...baseTool, id: oldId, description: "edited" });
    const kv = getContextKVStore();
    const before = await kv.get(`customtool:versions:${oldId}`);
    expect(before).toBeTruthy();

    await cleanupOrphanTestTools();
    const after = await kv.get(`customtool:versions:${oldId}`);
    expect(after).toBeFalsy();
  });
});

// ── REL-01 / Q-01 (2026-11 audit) ────────────────────────────────────
describe("custom-tools store — tenant isolation and corruption safety", () => {
  const baseTool = {
    id: "todo_add",
    description: "Add a task",
    destructive: true,
    inputs: [],
    steps: [{ kind: "transform" as const, template: "- [ ] x", saveAs: "line" }],
  };
  let tmp: string;
  const prevKv = process.env["MYMCP_KV_PATH"];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-custom-tools-rel-"));
    process.env["MYMCP_KV_PATH"] = path.join(tmp, "kv.json");
    resetKVStoreCache();
    _resetCustomToolsCacheForTests();
  });

  afterEach(async () => {
    if (prevKv === undefined) delete process.env["MYMCP_KV_PATH"];
    else process.env["MYMCP_KV_PATH"] = prevKv;
    resetKVStoreCache();
    _resetCustomToolsCacheForTests();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("REL-01: the sync snapshot of tenant A is never served to tenant B", async () => {
    const { runWithTenant } = await import("@/core/request-context");
    await runWithTenant("alpha", async () => {
      await createCustomTool({ ...baseTool, id: "alpha_tool" });
      await primeCustomToolsCache();
      expect(listCustomToolsSync().map((t) => t.id)).toEqual(["alpha_tool"]);
    });
    await runWithTenant("beta", async () => {
      expect(listCustomToolsSync()).toEqual([]);
    });
  });

  it("Q-01: a corrupt blob is an error, never an empty list (no silent overwrite)", async () => {
    await getContextKVStore().set("custom-tools:all", "{not json");
    await expect(listCustomTools()).rejects.toThrow(/not valid JSON/);
  });

  it("Q-01: a transient refresh failure keeps the last good snapshot", async () => {
    await createCustomTool({ ...baseTool, id: "keep_me" });
    await primeCustomToolsCache();
    await getContextKVStore().set("custom-tools:all", "{broken");
    await primeCustomToolsCache();
    expect(listCustomToolsSync().map((t) => t.id)).toEqual(["keep_me"]);
  });
});
