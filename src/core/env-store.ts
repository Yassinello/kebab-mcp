/**
 * EnvStore — abstraction over .env persistence.
 *
 * Two implementations:
 * - FilesystemEnvStore: reads/writes `./.env` on disk. Used for local dev and Docker.
 * - VercelEnvStore: uses Vercel REST API (VERCEL_TOKEN + VERCEL_PROJECT_ID). Triggers auto-redeploy.
 *
 * Selection: `process.env.VERCEL === "1"` → Vercel. Otherwise → Filesystem.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { toMsg } from "./error-utils";

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface EnvStore {
  kind: "filesystem" | "vercel";
  /** Read current env as a plain object. Filesystem reads `.env`, Vercel calls the API. */
  read(): Promise<Record<string, string>>;
  /** Merge and persist the given vars. Returns the count of vars written. */
  write(vars: Record<string, string>): Promise<{ written: number; note?: string }>;
  /**
   * Delete a single key from the store. NIT-09: previously routes that
   * wanted to "unset" a var wrote `""` instead. That left a dangling row
   * on Vercel and a bogus `KEY=` line in `.env`. The delete path removes
   * the entry entirely. No-ops if the key is not present.
   */
  delete(key: string): Promise<{ deleted: boolean; note?: string }>;
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
    if (!(await pathExists(this.envPath))) return {};
    const content = await fs.readFile(this.envPath, "utf-8");
    return parseEnvFile(content).vars;
  }

  async write(vars: Record<string, string>): Promise<{ written: number; note?: string }> {
    let existingLines: string[];
    if (await pathExists(this.envPath)) {
      const content = await fs.readFile(this.envPath, "utf-8");
      existingLines = parseEnvFile(content).rawLines;
    } else {
      existingLines = [
        "# Kebab MCP — environment variables",
        `# Created: ${new Date().toISOString().split("T")[0]}`,
        "",
      ];
    }

    const serialized = serializeEnv(existingLines, vars);

    // Atomic write: .env.tmp → rename
    const tmpPath = this.envPath + ".tmp";
    await fs.writeFile(tmpPath, serialized, "utf-8");
    await fs.rename(tmpPath, this.envPath);

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

  async delete(key: string): Promise<{ deleted: boolean; note?: string }> {
    if (!(await pathExists(this.envPath))) return { deleted: false };
    const content = await fs.readFile(this.envPath, "utf-8");
    const { rawLines } = parseEnvFile(content);
    let deleted = false;
    const out: string[] = [];
    for (const line of rawLines) {
      const m = line.match(ENV_LINE);
      if (m && m[1] === key) {
        deleted = true;
        continue;
      }
      out.push(line);
    }
    if (!deleted) return { deleted: false };

    let text = out.join("\n");
    if (!text.endsWith("\n")) text += "\n";
    const tmpPath = this.envPath + ".tmp";
    await fs.writeFile(tmpPath, text, "utf-8");
    await fs.rename(tmpPath, this.envPath);
    delete process.env[key];
    return { deleted: true, note: `Removed ${key} from .env.` };
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

// ── Vercel auto-magic redeploy ───────────────────────────────────────

/** True when VERCEL_TOKEN + VERCEL_PROJECT_ID are both present. */
export function isVercelAutoMagicAvailable(): boolean {
  return Boolean(process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID);
}

interface VercelGitSource {
  type?: string;
  repoId?: number | string;
  ref?: string;
  org?: string;
  repo?: string;
}

interface VercelDeploymentListItem {
  uid?: string;
  name?: string;
  meta?: { githubCommitRef?: string; [k: string]: unknown };
  gitSource?: VercelGitSource;
}

interface VercelDeploymentsListResponse {
  deployments?: VercelDeploymentListItem[];
}

interface VercelCreateDeploymentResponse {
  id?: string;
  uid?: string;
}

/**
 * Trigger a fresh production deployment of the latest git commit on Vercel.
 *
 * Best-effort: never throws. Returns `{ ok: false, error }` on any failure
 * with the Vercel token stripped from any error message. Has a 10s timeout
 * on each upstream fetch via AbortController.
 */
export async function triggerVercelRedeploy(): Promise<{
  ok: boolean;
  deploymentId?: string;
  error?: string;
}> {
  const token = process.env.VERCEL_TOKEN || "";
  const projectId = process.env.VERCEL_PROJECT_ID || "";
  const teamId = process.env.VERCEL_TEAM_ID || "";

  if (!token || !projectId) {
    return { ok: false, error: "VERCEL_TOKEN/VERCEL_PROJECT_ID not set" };
  }

  const teamQs = teamId ? `&teamId=${encodeURIComponent(teamId)}` : "";
  const teamQsAlone = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";

  // Step 1: fetch latest production deployment to extract gitSource + name.
  let latest: VercelDeploymentListItem | undefined;
  {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(
        `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1&target=production${teamQs}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          ok: false,
          error: `Vercel deployments list failed: ${res.status} ${sanitizeVercelBody(text, token)}`,
        };
      }
      const data = (await res.json()) as VercelDeploymentsListResponse;
      latest = data.deployments?.[0];
    } catch (e) {
      const msg = toMsg(e);
      return {
        ok: false,
        error: `Vercel deployments list error: ${sanitizeVercelBody(msg, token)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  if (!latest) {
    return { ok: false, error: "No prior production deployment found to redeploy" };
  }

  const projectName = latest.name;
  const gitSource = latest.gitSource;
  const ref = gitSource?.ref || latest.meta?.githubCommitRef;
  const repoId = gitSource?.repoId;

  if (!projectName || !gitSource?.type || !repoId || !ref) {
    return {
      ok: false,
      error: "Latest deployment is missing gitSource info — cannot redeploy automatically",
    };
  }

  // Step 2: create a fresh production deployment from the same git source.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const body = {
      name: projectName,
      target: "production",
      gitSource: {
        type: gitSource.type,
        repoId,
        ref,
      },
    };
    const res = await fetch(`https://api.vercel.com/v13/deployments${teamQsAlone}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Vercel create deployment failed: ${res.status} ${sanitizeVercelBody(text, token)}`,
      };
    }
    const data = (await res.json()) as VercelCreateDeploymentResponse;
    const deploymentId = data.id || data.uid;
    return { ok: true, deploymentId };
  } catch (e) {
    const msg = toMsg(e);
    return {
      ok: false,
      error: `Vercel create deployment error: ${sanitizeVercelBody(msg, token)}`,
    };
  } finally {
    clearTimeout(timer);
  }
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

  async delete(key: string): Promise<{ deleted: boolean; note?: string }> {
    const existing = await this.apiList();
    const found = existing.find((e) => e.key === key);
    if (!found?.id) return { deleted: false };
    const res = await fetch(
      `https://api.vercel.com/v9/projects/${this.projectId}/env/${found.id}${this.qs()}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.token}` },
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Vercel DELETE ${key} failed: ${res.status} ${sanitizeVercelBody(text, this.token)}`
      );
    }
    delete process.env[key];
    return {
      deleted: true,
      note: "Vercel env entry removed. A redeploy is typically required (~30s) for changes to apply.",
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
