/**
 * Contract test: .npmrc must exist and contain `legacy-peer-deps=true`.
 *
 * This file was introduced after three Vercel build failures caused by a peer
 * dependency conflict between mcp-handler@1.1.0 and @modelcontextprotocol/sdk@^1.29.0
 * (commits 60f146e, dd89ee5, e63d652). Without this flag, `npm install` fails on Vercel.
 *
 * Status after the mcp-handler 2.x migration (ADR 0005): the mcp-handler ↔ SDK
 * conflict is gone (mcp-handler@2 peers on @modelcontextprotocol/server@^2, which
 * we install), but a strict install still fails: @browserbasehq/stagehand bundles
 * openai@4, whose optional peer is zod@^3 while the project is on zod@4, and npm's
 * strict resolver then aborts ("Cannot read properties of null (reading 'edgesOut')").
 * Re-check with `npm install --legacy-peer-deps=false` in a scratch copy.
 *
 * To remove this test: once a strict install resolves cleanly, delete .npmrc, then
 * delete this test file.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = join(__dirname, "..", "..");
const NPMRC_PATH = join(PROJECT_ROOT, ".npmrc");

describe(".npmrc contract", () => {
  it(".npmrc exists (required to unblock Vercel peer-dep conflict)", () => {
    expect(
      existsSync(NPMRC_PATH),
      ".npmrc is missing. This file is required for a successful npm install on Vercel " +
        "(peer-dep conflicts: historically mcp-handler@1.1.0 vs @modelcontextprotocol/sdk, " +
        "now stagehand's openai@4 vs zod@4). To remove: make a strict install " +
        "(--legacy-peer-deps=false) resolve cleanly, then delete .npmrc and this test."
    ).toBe(true);
  });

  it(".npmrc contains legacy-peer-deps=true", () => {
    const content = readFileSync(NPMRC_PATH, "utf-8");
    const lines = content
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("#") && l.trim() !== "");

    const hasFlag = lines.some((l) => /^legacy-peer-deps\s*=\s*true$/.test(l.trim()));

    expect(
      hasFlag,
      "`.npmrc` exists but does not contain `legacy-peer-deps=true`. " +
        "This flag is required for Vercel deployments. " +
        "Add `legacy-peer-deps=true` to .npmrc, or remove this test once the peer conflict is resolved."
    ).toBe(true);
  });
});
