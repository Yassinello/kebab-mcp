/**
 * E2E smoke test for MyMCP.
 * Starts the dev server, calls tools/list via HTTP, verifies response.
 *
 * Run: npm run test:e2e
 * Requires: .env with at least MCP_AUTH_TOKEN set
 */

import { execSync, spawn } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

const PORT = 3999;
const BASE_URL = `http://localhost:${PORT}`;
const TIMEOUT_MS = 30_000;

// Load .env
try {
  const envPath = resolve(__dirname, "../.env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...vals] = trimmed.split("=");
    if (key && !process.env[key]) {
      process.env[key] = vals.join("=");
    }
  }
} catch {
  console.log("[E2E] No .env file found — using existing env vars");
}

const MCP_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!MCP_TOKEN) {
  console.error("[E2E] FAIL — MCP_AUTH_TOKEN not set");
  process.exit(1);
}

async function waitForServer(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Server did not start within timeout");
}

async function callToolsList(): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MCP_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });

  const text = await res.text();
  // Parse SSE response
  const dataLine = text
    .split("\n")
    .find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`Unexpected response: ${text.slice(0, 200)}`);

  const json = JSON.parse(dataLine.replace("data: ", ""));
  const tools = json.result?.tools || [];
  return tools.map((t: { name: string }) => t.name).sort();
}

async function main() {
  console.log("[E2E] Starting dev server on port", PORT);

  const server = spawn("npx", ["next", "dev", "--port", String(PORT)], {
    stdio: "pipe",
    shell: true,
    env: { ...process.env, PORT: String(PORT) },
  });

  let serverOutput = "";
  server.stdout?.on("data", (d) => { serverOutput += d.toString(); });
  server.stderr?.on("data", (d) => { serverOutput += d.toString(); });

  try {
    console.log("[E2E] Waiting for server...");
    await waitForServer();
    console.log("[E2E] Server ready\n");

    // Test 1: Health endpoint
    console.log("[E2E] Test 1: Health endpoint");
    const healthRes = await fetch(`${BASE_URL}/api/health`);
    const health = await healthRes.json();
    if (!health.ok) throw new Error(`Health check failed: ${JSON.stringify(health)}`);
    console.log(`  ✓ Health OK — version ${health.version}\n`);

    // Test 2: tools/list
    console.log("[E2E] Test 2: tools/list");
    const toolNames = await callToolsList();
    console.log(`  ✓ ${toolNames.length} tools returned\n`);

    // Test 3: Verify tool count >= 1 (at least admin pack)
    if (toolNames.length < 1) {
      throw new Error("No tools registered — at least admin pack should be active");
    }

    // Test 4: Check mcp_logs is always present (admin pack has no required env vars)
    if (!toolNames.includes("mcp_logs")) {
      throw new Error("mcp_logs not found — admin pack should always be active");
    }
    console.log("  ✓ mcp_logs present (admin pack always active)\n");

    // Test 5: Verify auth
    console.log("[E2E] Test 3: Auth rejection");
    const noAuthRes = await fetch(`${BASE_URL}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    if (noAuthRes.status !== 401) {
      throw new Error(`Expected 401 without auth, got ${noAuthRes.status}`);
    }
    console.log("  ✓ 401 returned without auth\n");

    console.log("[E2E] ALL TESTS PASSED ✓");
    console.log(`  Tools: ${toolNames.length}`);
    console.log(`  Packs active: check /api/admin/status for details`);
  } catch (err) {
    console.error("\n[E2E] FAIL:", err instanceof Error ? err.message : err);
    if (serverOutput.includes("Error")) {
      console.error("\nServer output (last 500 chars):");
      console.error(serverOutput.slice(-500));
    }
    process.exit(1);
  } finally {
    server.kill();
    // Give it a moment to clean up
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main();
