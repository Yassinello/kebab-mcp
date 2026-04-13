/**
 * EnvStore — abstraction over .env persistence.
 *
 * Two implementations:
 * - FilesystemEnvStore: reads/writes `./.env` on disk. Used for local dev and Docker.
 * - VercelEnvStore: uses Vercel REST API (VERCEL_TOKEN + VERCEL_PROJECT_ID). Triggers auto-redeploy.
 *
 * Selection: `process.env.VERCEL === "1"` → Vercel. Otherwise → Filesystem.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface EnvStore {
  kind: "filesystem" | "vercel";
  /** Read current env as a plain object. Filesystem reads `.env`, Vercel calls the API. */
  read(): Promise<Record<string, string>>;
  /** Merge and persist the given vars. Returns the count of vars written. */
  write(vars: Record<string, string>): Promise<{ written: number; note?: string }>;
}

// ── Filesystem impl ──────────────────────────────────────────────────

const ENV_LINE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;

export function parseEnvFile(content: string): {
  vars: Record<string, string>;
  rawLines: string[];
} {
  const vars: Record<string, string> = {};
  const rawLines = content.split(/\r?\n/);
  for (const line of rawLines) {
    const m = line.match(ENV_LINE);
    if (m) {
      let value = m[2];
      // Strip surrounding quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[m[1]] = value;
    }
  }
  return { vars, rawLines };
}

export function serializeEnv(existingLines: string[], updates: Record<string, string>): string {
  const pending = new Set(Object.keys(updates));
  const out: string[] = [];

  for (const line of existingLines) {
    const m = line.match(ENV_LINE);
    if (m && pending.has(m[1])) {
      const v = updates[m[1]];
      out.push(`${m[1]}=${v}`);
      pending.delete(m[1]);
    } else {
      out.push(line);
    }
  }

  // Append new vars at end
  if (pending.size > 0) {
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    for (const k of pending) {
      out.push(`${k}=${updates[k]}`);
    }
  }

  // Ensure trailing newline
  let text = out.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

class FilesystemEnvStore implements EnvStore {
  kind = "filesystem" as const;
  private envPath: string;

  constructor() {
    this.envPath = join(process.cwd(), ".env");
  }

  async read(): Promise<Record<string, string>> {
    if (!existsSync(this.envPath)) return {};
    const content = readFileSync(this.envPath, "utf-8");
    return parseEnvFile(content).vars;
  }

  async write(vars: Record<string, string>): Promise<{ written: number; note?: string }> {
    let existingLines: string[];
    if (existsSync(this.envPath)) {
      const content = readFileSync(this.envPath, "utf-8");
      existingLines = parseEnvFile(content).rawLines;
    } else {
      existingLines = [
        "# MyMCP — environment variables",
        `# Created: ${new Date().toISOString().split("T")[0]}`,
        "",
      ];
    }

    const serialized = serializeEnv(existingLines, vars);

    // Atomic write: .env.tmp → rename
    const tmpPath = this.envPath + ".tmp";
    writeFileSync(tmpPath, serialized, "utf-8");
    renameSync(tmpPath, this.envPath);

    // Also update process.env so subsequent reads in the same process see new values
    // (Next.js will auto-reload the dev server but this makes the change visible immediately)
    for (const [k, v] of Object.entries(vars)) {
      process.env[k] = v;
    }

    return {
      written: Object.keys(vars).length,
      note: "Written to .env. Dev server auto-reloads on change.",
    };
  }
}

// ── Vercel impl ──────────────────────────────────────────────────────

interface VercelEnvVar {
  id?: string;
  key: string;
  value: string;
  target?: string[];
  type?: string;
}

/** Strip Vercel token and truncate an upstream response body for safe error messages. */
function sanitizeVercelBody(text: string, token: string): string {
  let out = text;
  if (token) out = out.split(token).join("<redacted>");
  if (out.length > 500) out = out.slice(0, 500) + "…";
  return out;
}

class VercelEnvStore implements EnvStore {
  kind = "vercel" as const;
  private token: string;
  private projectId: string;
  private teamId?: string;

  constructor() {
    this.token = process.env.VERCEL_TOKEN || "";
    this.projectId = process.env.VERCEL_PROJECT_ID || "";
    this.teamId = process.env.VERCEL_TEAM_ID || undefined;
    if (!this.token || !this.projectId) {
      throw new Error(
        "Vercel env store requires VERCEL_TOKEN and VERCEL_PROJECT_ID environment variables"
      );
    }
  }

  private qs(): string {
    return this.teamId ? `?teamId=${this.teamId}` : "";
  }

  private async apiList(): Promise<VercelEnvVar[]> {
    const res = await fetch(
      `https://api.vercel.com/v10/projects/${this.projectId}/env${this.qs()}`,
      {
        headers: { Authorization: `Bearer ${this.token}` },
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Vercel API list failed: ${res.status} ${sanitizeVercelBody(text, this.token)}`
      );
    }
    const data = (await res.json()) as { envs: VercelEnvVar[] };
    return data.envs || [];
  }

  async read(): Promise<Record<string, string>> {
    const envs = await this.apiList();
    const out: Record<string, string> = {};
    for (const e of envs) {
      // Vercel masks encrypted values — only decrypted/plain ones will have value
      if (e.value !== undefined) out[e.key] = e.value;
    }
    return out;
  }

  async write(vars: Record<string, string>): Promise<{ written: number; note?: string }> {
    const existing = await this.apiList();
    const byKey = new Map(existing.map((e) => [e.key, e]));

    let written = 0;
    for (const [key, value] of Object.entries(vars)) {
      const found = byKey.get(key);
      const body = JSON.stringify({
        key,
        value,
        type: "encrypted",
        target: ["production", "preview", "development"],
      });

      if (found?.id) {
        // PATCH existing
        const res = await fetch(
          `https://api.vercel.com/v9/projects/${this.projectId}/env/${found.id}${this.qs()}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${this.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              value,
              target: ["production", "preview", "development"],
            }),
          }
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(
            `Vercel PATCH ${key} failed: ${res.status} ${sanitizeVercelBody(text, this.token)}`
          );
        }
      } else {
        // POST new
        const res = await fetch(
          `https://api.vercel.com/v10/projects/${this.projectId}/env${this.qs()}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.token}`,
              "Content-Type": "application/json",
            },
            body,
          }
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(
            `Vercel POST ${key} failed: ${res.status} ${sanitizeVercelBody(text, this.token)}`
          );
        }
      }
      written++;
    }

    return {
      written,
      note: "Vercel env updated. A redeploy is typically required (~30s) for changes to apply.",
    };
  }
}

// ── Factory ──────────────────────────────────────────────────────────

let cached: EnvStore | null = null;

export function getEnvStore(): EnvStore {
  if (cached) return cached;
  if (process.env.VERCEL === "1" && process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID) {
    cached = new VercelEnvStore();
  } else {
    cached = new FilesystemEnvStore();
  }
  return cached;
}

/** Mask a sensitive value for display. */
export function maskValue(key: string, value: string): string {
  const sensitive =
    /TOKEN|SECRET|KEY|PAT|PASSWORD|CREDENTIAL/i.test(key) ||
    key === "MCP_AUTH_TOKEN" ||
    key === "ADMIN_AUTH_TOKEN";
  if (!sensitive || !value) return value;
  if (value.length <= 12) return "••••••••";
  return `${value.slice(0, 4)}${"•".repeat(Math.max(8, value.length - 8))}${value.slice(-4)}`;
}
