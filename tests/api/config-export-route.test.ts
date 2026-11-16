/**
 * 2026-11 audit (B1) — POST /api/config/export (import): oversized bodies
 * are refused early, bombs and unreadable zips get a clear error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { zipSync, strToU8 } from "fflate";

vi.mock("@/core/auth", async (orig) => ({
  ...(await orig<typeof import("@/core/auth")>()),
  checkAdminAuth: async () => null,
}));

import { resetKVStoreCache } from "@/core/kv-store";
import { MAX_IMPORT_BYTES } from "@/core/full-export";
import { POST } from "../../app/api/config/export/route";

let tmpDir = "";
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-export-route-"));
  vi.stubEnv("MYMCP_KV_PATH", path.join(tmpDir, "kv.json"));
  vi.stubEnv("GITHUB_PAT", "");
  vi.stubEnv("GITHUB_REPO", "");
  resetKVStoreCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetKVStoreCache();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/config/export", {
    method: "POST",
    headers: { "Content-Type": "application/zip", ...headers },
    body,
    // Required by undici for a streamed request body.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

describe("POST /api/config/export (import)", () => {
  it("413 when the declared size is above the limit, without reading the body", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const res = await POST(post(stream, { "Content-Length": String(MAX_IMPORT_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "too_large" });
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("413 when a streamed body passes the limit (stops reading)", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent > MAX_IMPORT_BYTES * 3) controller.close();
      },
    });
    const res = await POST(post(stream));
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(MAX_IMPORT_BYTES * 2);
  });

  it("413 with a clear message for a zip bomb", async () => {
    const bomb = zipSync({ "vault/bomb.md": new Uint8Array(120 * 1024 * 1024) }, { level: 1 });
    const res = await POST(post(bomb));
    expect(res.status).toBe(413);
    expect((await res.json()).message).toMatch(/expands to more than 100 MB/);
  });

  it("400 for something that is not a zip; 200 with a report for a valid one", async () => {
    const bad = await POST(post(strToU8("not a zip at all")));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "import_failed" });

    const ok = await POST(post(zipSync({ "vault/Inbox/hello": strToU8("hi") })));
    expect(ok.status).toBe(200);
    const data = (await ok.json()) as { report: { notes: { written: number; renamed: number } } };
    expect(data.report.notes).toMatchObject({ written: 1, renamed: 1 });
  });
});
