#!/usr/bin/env node

// create-mymcp — Interactive installer for MyMCP
// Usage: npx @yassinello/create-mymcp@latest

import { execSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const log = (msg) => console.log(msg);
const step = (n, msg) => log(`\n${CYAN}[${n}]${RESET} ${BOLD}${msg}${RESET}`);
const ok = (msg) => log(`  ${GREEN}✓${RESET} ${msg}`);
const warn = (msg) => log(`  ${YELLOW}!${RESET} ${msg}`);
const info = (msg) => log(`  ${DIM}${msg}${RESET}`);

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }).trim();
  } catch {
    return null;
  }
}

function hasCommand(cmd) {
  const check = process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`;
  return run(check) !== null;
}

async function confirm(msg, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await ask(`  ${msg} [${hint}] `)).trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

/** Clean user input: strip surrounding quotes, trim whitespace */
function cleanPath(input) {
  return input.trim().replace(/^["']|["']$/g, "");
}

/** Check if a directory exists and is non-empty */
function isDirNonEmpty(dir) {
  try {
    const entries = readdirSync(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

// ── Pack definitions ─────────────────────────────────────────────────

const PACKS = [
  {
    id: "google",
    name: "Google Workspace",
    tools: "Gmail, Calendar, Contacts, Drive (18 tools)",
    vars: [
      {
        key: "GOOGLE_CLIENT_ID",
        prompt: "Google OAuth Client ID",
        help: "https://console.cloud.google.com/apis/credentials",
      },
      { key: "GOOGLE_CLIENT_SECRET", prompt: "Google OAuth Client Secret" },
      {
        key: "GOOGLE_REFRESH_TOKEN",
        prompt: "Google OAuth Refresh Token",
        help: "Run the OAuth flow after deploy at /api/auth/google",
        optional: true,
      },
    ],
  },
  {
    id: "vault",
    name: "Obsidian Vault",
    tools: "Read, write, search, backlinks, web clipper (15 tools)",
    vars: [
      {
        key: "GITHUB_PAT",
        prompt: "GitHub PAT (with repo scope)",
        help: "https://github.com/settings/tokens",
      },
      {
        key: "GITHUB_REPO",
        prompt: "GitHub repo (owner/repo format)",
      },
    ],
  },
  {
    id: "browser",
    name: "Browser Automation",
    tools: "Web browse, extract, act, LinkedIn feed (4 tools)",
    vars: [
      {
        key: "BROWSERBASE_API_KEY",
        prompt: "Browserbase API key",
        help: "https://browserbase.com",
      },
      { key: "BROWSERBASE_PROJECT_ID", prompt: "Browserbase Project ID" },
      {
        key: "OPENROUTER_API_KEY",
        prompt: "OpenRouter API key",
        help: "https://openrouter.ai/keys",
      },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    tools: "Channels, messages, threads, profiles, search (6 tools)",
    vars: [
      {
        key: "SLACK_BOT_TOKEN",
        prompt: "Slack Bot User OAuth Token",
        help: "https://api.slack.com/apps → OAuth & Permissions",
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    tools: "Search, read, create, update, query databases (5 tools)",
    vars: [
      {
        key: "NOTION_API_KEY",
        prompt: "Notion Internal Integration Token",
        help: "https://www.notion.so/my-integrations",
      },
    ],
  },
  {
    id: "composio",
    name: "Composio",
    tools: "1000+ app integrations — Jira, HubSpot, Salesforce, Airtable... (2 tools)",
    vars: [
      {
        key: "COMPOSIO_API_KEY",
        prompt: "Composio API key",
        help: "https://composio.dev → Settings",
      },
    ],
  },
];

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  log("");
  log(
    `${BOLD}  ╔══════════════════════════════════════════╗${RESET}`
  );
  log(
    `${BOLD}  ║          ${CYAN}create-mymcp${RESET}${BOLD}                    ║${RESET}`
  );
  log(
    `${BOLD}  ║  Your personal AI backend in minutes     ║${RESET}`
  );
  log(
    `${BOLD}  ╚══════════════════════════════════════════╝${RESET}`
  );

  // ── Step 1: Project directory ────────────────────────────────────

  step("1/5", "Project setup");

  const defaultDir = "mymcp";
  const rawInput = (await ask(`  Project directory [${defaultDir}]: `)).trim();
  const cleaned = cleanPath(rawInput) || defaultDir;

  // If it's already absolute, use as-is; otherwise resolve relative to CWD
  const projectDir = isAbsolute(cleaned) ? cleaned : resolve(cleaned);
  const projectName = projectDir.split(/[/\\]/).pop();

  if (existsSync(projectDir) && isDirNonEmpty(projectDir)) {
    log(`  ${RED}✗${RESET} Directory "${projectDir}" already exists and is not empty.`);
    rl.close();
    process.exit(1);
  }

  info(`Will create: ${projectDir}`);

  // ── Step 2: Clone ────────────────────────────────────────────────

  step("2/5", "Cloning MyMCP");

  if (!hasCommand("git")) {
    log(`  ${RED}✗${RESET} git is required. Install it from https://git-scm.com`);
    rl.close();
    process.exit(1);
  }

  const cloneResult = spawnSync(
    "git",
    ["clone", "https://github.com/Yassinello/mymcp.git", projectDir],
    { stdio: "inherit" }
  );

  if (cloneResult.status !== 0) {
    log(`  ${RED}✗${RESET} Failed to clone repository.`);
    rl.close();
    process.exit(1);
  }

  // Set up upstream remote for easy updates
  run(`git -C "${projectDir}" remote rename origin upstream`);
  ok("Cloned and upstream remote configured");
  info("Run `npm run update` to pull updates anytime");

  // ── Step 3: Pick packs ───────────────────────────────────────────

  step("3/5", "Choose your tool packs");
  log("");

  const selectedPacks = [];
  for (const pack of PACKS) {
    const defaultOn = pack.id === "vault" || pack.id === "google";
    const yes = await confirm(
      `${BOLD}${pack.name}${RESET} — ${pack.tools}?`,
      defaultOn
    );
    if (yes) selectedPacks.push(pack);
  }

  if (selectedPacks.length === 0) {
    warn("No packs selected. You can add them later in your .env file.");
  } else {
    ok(`Selected: ${selectedPacks.map((p) => p.name).join(", ")}`);
  }

  // ── Step 4: Collect credentials ──────────────────────────────────

  step("4/5", "Configure credentials");

  const envVars = {};

  // Generate MCP auth token
  envVars.MCP_AUTH_TOKEN = randomBytes(32).toString("hex");
  ok(`MCP_AUTH_TOKEN generated: ${envVars.MCP_AUTH_TOKEN.slice(0, 8)}...`);

  // Instance settings
  log("");
  const tz = (await ask(`  Timezone [UTC]: `)).trim() || "UTC";
  const locale = (await ask(`  Locale [en-US]: `)).trim() || "en-US";
  const displayName = (await ask(`  Display name [User]: `)).trim() || "User";
  envVars.MYMCP_TIMEZONE = tz;
  envVars.MYMCP_LOCALE = locale;
  envVars.MYMCP_DISPLAY_NAME = displayName;

  // Pack credentials
  for (const pack of selectedPacks) {
    log("");
    log(`  ${BOLD}${pack.name}${RESET}`);
    for (const v of pack.vars) {
      if (v.help) info(v.help);
      if (v.optional) {
        info("(optional — press Enter to skip)");
      }
      const value = (await ask(`  ${v.prompt}: `)).trim();
      if (value) {
        envVars[v.key] = value;
        ok(`${v.key} set`);
      } else if (!v.optional) {
        warn(`${v.key} skipped — ${pack.name} pack won't activate until set`);
      }
    }
  }

  // ── Write .env ───────────────────────────────────────────────────

  const envPath = join(projectDir, ".env");
  const envExamplePath = join(projectDir, ".env.example");

  // Read .env.example as base, then overlay collected values
  let envContent = "# MyMCP — Generated by create-mymcp\n";
  envContent += `# Created: ${new Date().toISOString().split("T")[0]}\n\n`;

  // Track which vars we've written so we don't duplicate
  const writtenVars = new Set();

  if (existsSync(envExamplePath)) {
    const example = readFileSync(envExamplePath, "utf-8");
    const lines = example.split("\n");
    for (const line of lines) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && envVars[match[1]] !== undefined) {
        envContent += `${match[1]}=${envVars[match[1]]}\n`;
        writtenVars.add(match[1]);
      } else {
        envContent += line + "\n";
      }
    }
  }

  // Append any remaining vars not in .env.example
  for (const [key, value] of Object.entries(envVars)) {
    if (!writtenVars.has(key)) {
      envContent += `${key}=${value}\n`;
    }
  }

  writeFileSync(envPath, envContent);
  ok(".env file created");

  // ── Step 5: Install & Deploy ─────────────────────────────────────

  step("5/5", "Install & deploy");

  // Install dependencies
  log("");
  info("Installing dependencies...");
  const installResult = spawnSync("npm", ["install"], {
    cwd: projectDir,
    stdio: "inherit",
    shell: true,
  });

  if (installResult.status !== 0) {
    warn("npm install failed — you can run it manually later");
  } else {
    ok("Dependencies installed");
  }

  // Offer Vercel deploy
  log("");
  const deployVercel = await confirm(
    "Deploy to Vercel now? (requires Vercel CLI)",
    false
  );

  if (deployVercel) {
    if (!hasCommand("vercel")) {
      info("Installing Vercel CLI...");
      spawnSync("npm", ["install", "-g", "vercel"], {
        stdio: "inherit",
        shell: true,
      });
    }

    log("");
    info("Running vercel deploy...");
    const vercelResult = spawnSync("vercel", ["--yes"], {
      cwd: projectDir,
      stdio: "inherit",
      shell: true,
    });

    if (vercelResult.status === 0) {
      ok("Deployed to Vercel!");
      log("");
      warn("Don't forget to add your env vars in the Vercel dashboard:");
      info("Vercel → Project Settings → Environment Variables");
      info("Or run: vercel env add MCP_AUTH_TOKEN");
    } else {
      warn("Deploy failed — you can run `vercel` manually in your project dir");
    }
  }

  // ── Done ─────────────────────────────────────────────────────────

  log("");
  log(`${BOLD}  ╔══════════════════════════════════════════╗${RESET}`);
  log(`${BOLD}  ║           ${GREEN}Setup complete!${RESET}${BOLD}                 ║${RESET}`);
  log(`${BOLD}  ╚══════════════════════════════════════════╝${RESET}`);
  log("");
  log(`  ${BOLD}Next steps:${RESET}`);
  log("");
  log(`  ${CYAN}cd ${projectName}${RESET}`);
  if (!deployVercel) {
    log(`  ${CYAN}npm run dev${RESET}              ${DIM}# Start locally${RESET}`);
    log(`  ${CYAN}vercel${RESET}                   ${DIM}# Deploy to Vercel${RESET}`);
  }
  log(`  ${CYAN}open /setup${RESET}              ${DIM}# Guided setup page${RESET}`);
  log("");
  log(`  ${BOLD}Connect to Claude Desktop / Claude Code:${RESET}`);
  log(`  ${DIM}Endpoint: https://your-app.vercel.app/api/mcp${RESET}`);
  log(`  ${DIM}Token:    starts with ${envVars.MCP_AUTH_TOKEN ? envVars.MCP_AUTH_TOKEN.slice(0, 8) + "..." : "(check your .env)"}${RESET}`);
  log("");
  log(`  ${BOLD}Stay up to date:${RESET}`);
  log(`  ${CYAN}npm run update${RESET}`);
  log("");

  rl.close();
}

main().catch((err) => {
  console.error(`\n${RED}Error:${RESET} ${err.message}`);
  rl.close();
  process.exit(1);
});
