/**
 * TEST-03 batch A.2 — storage-ux regressions.
 *
 * Maps to BUG-INVENTORY.md rows: BUG-12, BUG-13, BUG-16 (storage-ux theme).
 * One it() per bug; assertion name mirrors the BUG-NN ID.
 *
 * Covered session fixes:
 *   - ccdaa3d — storage-first flow (storage step precedes token mint)
 *   - c339fc7 — one-decision storage redesign (single primary CTA)
 *   - 0b5c737 — storage-status rehydrate + Kebab MCP branding
 *
 * Strategy: these are primarily UI / copy regressions. We assert the
 * server-observable contracts (route rehydrates, route handler wraps
 * in withBootstrapRehydrate) AND grep-contract the client-side layout
 * primitives the fixes introduced. A future refactor could extract
 * the welcome wizard step model to a pure function that's easier to
 * unit-test directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── Helpers ──────────────────────────────────────────────────────────

function readClient(): string {
  // Phase 45 Task 5 moved the welcome render tree from `welcome-client.tsx`
  // (a 29-LOC shim) into `WelcomeShell.tsx`.
  // Phase 47 WIRE-01a/b/c/d further migrated each step's JSX subtree into
  // app/welcome/steps/{storage,mint,test,already-initialized}.tsx.
  // Phase 47 WIRE-05 retired the `welcome-client.tsx` shim — page.tsx
  // now imports WelcomeShell directly. Read all files that currently
  // carry welcome JSX; fall back gracefully if the shim is gone.
  const shim = (() => {
    try {
      return readFileSync(resolve(process.cwd(), "app/welcome/welcome-client.tsx"), "utf-8");
    } catch {
      return "";
    }
  })();
  const shell = readFileSync(resolve(process.cwd(), "app/welcome/WelcomeShell.tsx"), "utf-8");
  const chrome = readFileSync(resolve(process.cwd(), "app/welcome/chrome.tsx"), "utf-8");
  const storage = readFileSync(resolve(process.cwd(), "app/welcome/steps/storage.tsx"), "utf-8");
  const mint = readFileSync(resolve(process.cwd(), "app/welcome/steps/mint.tsx"), "utf-8");
  const test = readFileSync(resolve(process.cwd(), "app/welcome/steps/test.tsx"), "utf-8");
  const already = readFileSync(
    resolve(process.cwd(), "app/welcome/steps/already-initialized.tsx"),
    "utf-8"
  );
  return [shim, shell, chrome, storage, mint, test, already].join("\n");
}

function readStatusRoute(): string {
  return readFileSync(resolve(process.cwd(), "app/api/storage/status/route.ts"), "utf-8");
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("TEST-03 batch A.2 — storage-ux regressions", () => {
  // ── BUG-12 — storage step runs BEFORE token mint (ccdaa3d) ──────────
  it("regression: BUG-12 welcome wizard puts storage step before token mint", () => {
    // The fix reordered the wizard so users pick a durable storage mode
    // BEFORE /api/welcome/init mints a token. Pre-ccdaa3d, the order
    // was reversed, opening a 15-30 min window where a freshly-minted
    // token lived only on lambda-local /tmp.
    //
    // We assert the UI contract via its shipped primitives:
    //   1. `StorageStep` (or similar) is referenced in welcome-client.tsx.
    //   2. The wizard's step ordering places storage ahead of token mint.
    //   3. A save-token confirmation step exists ("I saved my token" ack
    //      — the post-ccdaa3d forced ack preventing silent loss).
    const client = readClient();

    // Storage step lands in the wizard. We look for the step label or
    // the storage-mode detection helper.
    expect(client).toMatch(/storage/i);

    // Forced ack on the token save step. Either a checkbox with "saved"
    // in its label, or an `acked` state variable, both acceptable. Post-
    // ccdaa3d this affordance exists in some form.
    const hasForcedAck =
      /I (have )?saved/i.test(client) ||
      /acked/i.test(client) ||
      /tokenSaved/i.test(client) ||
      /hasSavedToken/i.test(client);
    expect(hasForcedAck).toBe(true);

    // The regression marker: the file's wizard-state docstring declares
    // "step 1 = Storage, step 2 = Auth token, step 3 = Connect". If
    // someone reverts to the pre-ccdaa3d order (token first, storage
    // second), that comment-or-equivalent no longer carries storage
    // before auth/token. We pin the ordering contract here.
    const stepDeclaration = client.match(
      /step\s+1\s*=\s*Storage[\s\S]{0,200}step\s+2\s*=\s*(Auth|Token)/i
    );
    expect(stepDeclaration).not.toBeNull();
  });

  // ── BUG-13 — one-decision storage redesign (c339fc7) ────────────────
  it("regression: BUG-13 storage step surfaces single primary CTA", () => {
    // v4 separates detection from choice. A primary "Set up Upstash"
    // CTA appears when the current mode isn't already durable, AND
    // fallback options are tucked behind "Other storage options".
    //
    // Contract via the client file:
    //   - The storage step markup references Upstash as a primary
    //     action (button / link to the integration).
    //   - A `<details>` (or "advanced" disclosure) holds the fallback
    //     options.
    const client = readClient();

    // Primary CTA surface — the Upstash integration link is the
    // post-c339fc7 primary action.
    expect(client).toMatch(/upstash/i);

    // The "Other storage options" disclosure (<details> element, or
    // an "advanced" toggle). Either the string "Other storage" or a
    // `<details>` block near the storage-step ref is acceptable.
    const hasAdvancedDisclosure =
      /Other storage options/i.test(client) ||
      /<details[\s\S]{0,800}storage/i.test(client) ||
      /advanced/i.test(client);
    expect(hasAdvancedDisclosure).toBe(true);
  });

  // ── BUG-16 — storage-status rehydrates before auth (0b5c737) ────────
  it("regression: BUG-16 storage-status route rehydrates before auth", () => {
    // The fix: /api/storage/status rehydrates on entry so a cold lambda
    // that didn't serve the welcome/claim call won't 401 every
    // welcome-client status poll (leaving the user stuck on "Detecting
    // your storage…" indefinitely).
    //
    // Phase 37: rehydrate happened via the `withBootstrapRehydrate` HOC.
    // Phase 41: rehydrate moved into the pipeline as `rehydrateStep`
    // and the HOC was replaced with `composeRequestPipeline([rehydrateStep, …])`.
    // Either shape closes the bug — we accept both.
    const route = readStatusRoute();

    const hasHoc = /withBootstrapRehydrate/.test(route);
    const hasPipelineRehydrate =
      /composeRequestPipeline\s*\(/.test(route) && /\brehydrateStep\b/.test(route);
    expect(hasHoc || hasPipelineRehydrate).toBe(true);

    // The export must wrap the handler through one of those shapes.
    expect(route).toMatch(/export const GET\s*=\s*(withBootstrapRehydrate|composeRequestPipeline)/);

    // And the handler must accept claim cookie OR admin auth OR
    // loopback during bootstrap (BUG-14 sibling — storage-status was
    // part of the same family). We assert the logic shape:
    expect(route).toMatch(/isClaimer/);
    expect(route).toMatch(/checkAdminAuth|isLoopbackRequest/);
  });
});
