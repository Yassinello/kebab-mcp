/**
 * Integration test — starts a production Next.js server and verifies
 * health + MCP endpoints respond correctly.
 *
 * Prerequisites:
 *   - `npm run build` must have been run first (needs .next/ output)
 *
 * Run standalone:
 *   npm run test:integration
 *
 * Excluded from the main vitest suite (too slow for unit runs).
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";

const AUTH_TOKEN = "test-token-integration";
// Random port in 3100-3999, skipping the ports fetch() refuses to connect to
// (the WHATWG "bad port" list: 3659 is the only one in this range). CI hit it
// once: "fetch failed — bad port".
const FETCH_BAD_PORTS = new Set([3659]);
let PORT = 3100 + randomInt(900);
while (FETCH_BAD_PORTS.has(PORT)) PORT = 3100 + randomInt(900);
const BASE = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

let server: ChildProcess | null = null;

/** Poll a URL until it returns 200 or timeout. */
async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`);
}

describe("Server startup integration", () => {
  // Start server before all tests in this file
  it(
    "starts the server",
    async () => {
      // Use npx to find the correct next binary (works cross-platform)
      const isWindows = process.platform === "win32";
      const cmd = isWindows ? "npx.cmd" : "npx";

      server = spawn(cmd, ["next", "start", "-p", String(PORT)], {
        env: {
          ...process.env,
          MCP_AUTH_TOKEN: AUTH_TOKEN,
          PORT: String(PORT),
          NODE_ENV: "production",
        },
        stdio: "pipe",
        // shell: true is needed on Windows for npx.cmd
        shell: isWindows,
      });

      // Forward server stderr for debugging
      server.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) console.error(`[server] ${text}`);
      });

      await waitForReady(`${BASE}/api/health`, STARTUP_TIMEOUT_MS);
    },
    STARTUP_TIMEOUT_MS + 5_000
  );

  it("GET /api/health returns { ok: true }", async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBeDefined();
  });

  it("GET /api/health?deep=1 with auth returns 200", async () => {
    const res = await fetch(`${BASE}/api/health?deep=1`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBeDefined();
    expect(body.version).toBeDefined();
  });

  it("POST /api/mcp with auth returns valid MCP session init", async () => {
    // Send an MCP initialize request per the protocol
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1.0.0" },
      },
    };

    const res = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify(initRequest),
    });

    // MCP server should return 200 with a response (SSE or JSON)
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    // Should contain an initialize result with protocol version
    expect(text).toContain("protocolVersion");
  });

  afterAll(() => {
    if (server) {
      // On Windows, kill the process tree
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(server.pid), "/f", "/t"], { shell: true });
      } else {
        server.kill("SIGTERM");
      }
      server = null;
    }
  });
});
