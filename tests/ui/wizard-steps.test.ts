/**
 * Tests for `wizard-steps` — the pure step-ordering + gate-predicate
 * module that feeds `WelcomeShell` (Phase 45 Task 2, UX-02b).
 *
 * Extracted from the inline `WizardStep` state machine in
 * `app/welcome/welcome-client.tsx` so the truth-table can be asserted
 * directly rather than via JSX-grep contracts (Phase 40 FOLLOW-UP B).
 */
import { describe, it, expect } from "vitest";
import {
  STEPS,
  canAdvanceToMint,
  canAdvanceToTest,
  isTerminal,
  nextStep,
  shouldSkipStorageStep,
  type WelcomeState,
  type WizardStep,
} from "../../app/welcome/wizard-steps";

function base(overrides: Partial<WelcomeState> = {}): WelcomeState {
  return {
    claim: "claimer",
    step: "storage",
    token: null,
    tokenSaved: false,
    storage: { healthy: false, mode: "memory" },
    ...overrides,
  };
}

describe("wizard-steps", () => {
  it("STEPS is a frozen array in declared order", () => {
    expect(STEPS).toEqual(["storage", "mint", "test", "done"]);
    // Hard-pin the length so a future refactor that adds a step
    // notices this test before updating the step-component routing.
    expect(STEPS.length).toBe(4);
    // `readonly` in TS is a compile-time contract; at runtime we
    // defensively expect the array object to be the same reference
    // across reads — asserting `Object.isFrozen` matches the `as const`
    // declaration's intent.
    expect(Object.isFrozen(STEPS)).toBe(true);
  });

  it("canAdvanceToMint: true iff storage is healthy and non-memory", () => {
    expect(canAdvanceToMint(base({ storage: { healthy: true, mode: "upstash" } }))).toBe(true);
    expect(canAdvanceToMint(base({ storage: { healthy: true, mode: "filesystem" } }))).toBe(true);
    // memory mode never qualifies, even when the detector says "healthy"
    // (the instance works for this warm lambda but cold-start wipes it).
    expect(canAdvanceToMint(base({ storage: { healthy: true, mode: "memory" } }))).toBe(false);
    // unhealthy storage blocks mint regardless of mode.
    expect(canAdvanceToMint(base({ storage: { healthy: false, mode: "upstash" } }))).toBe(false);
  });

  it("canAdvanceToTest: true iff a token is present AND user confirmed saved", () => {
    expect(canAdvanceToTest(base({ token: "tok", tokenSaved: true }))).toBe(true);
    expect(canAdvanceToTest(base({ token: "tok", tokenSaved: false }))).toBe(false);
    expect(canAdvanceToTest(base({ token: null, tokenSaved: true }))).toBe(false);
    expect(canAdvanceToTest(base({ token: null, tokenSaved: false }))).toBe(false);
  });

  it("isTerminal: true on step=done OR claim=already-initialized", () => {
    expect(isTerminal(base({ step: "done" }))).toBe(true);
    expect(isTerminal(base({ claim: "already-initialized" }))).toBe(true);
    // step=done + claim=claimer still terminal (done wins).
    expect(isTerminal(base({ step: "done", claim: "claimer" }))).toBe(true);
    // Non-terminal defaults.
    expect(isTerminal(base({ step: "storage" }))).toBe(false);
    expect(isTerminal(base({ step: "mint" }))).toBe(false);
    expect(isTerminal(base({ step: "test" }))).toBe(false);
  });

  it("nextStep: returns the next step given current + gate predicates", () => {
    // storage → mint only when the mint-gate clears.
    expect(nextStep("storage", base({ storage: { healthy: true, mode: "upstash" } }))).toBe("mint");
    // gate blocked → stay on storage.
    expect(nextStep("storage", base({ storage: { healthy: true, mode: "memory" } }))).toBe(
      "storage"
    );

    // mint → test only when tokenSaved + token present.
    expect(nextStep("mint", base({ token: "t", tokenSaved: true }))).toBe("test");
    expect(nextStep("mint", base({ token: "t", tokenSaved: false }))).toBe("mint");
    expect(nextStep("mint", base({ token: null, tokenSaved: true }))).toBe("mint");

    // test → done always (last wizard step, gated by the dispatch layer
    // rather than a predicate — user clicks "Finish" deliberately).
    expect(nextStep("test", base({ token: "t" }))).toBe("done");

    // done is terminal.
    expect(nextStep("done", base())).toBe("done");
  });

  it("nextStep: already-initialized claim state short-circuits to done", () => {
    // If the claim resolves to already-initialized mid-flow (e.g. a
    // second browser acquired the cookie), every nextStep answer
    // becomes "done" so the UI can render AlreadyInitializedPanel.
    const alreadyInit: WelcomeState = base({ claim: "already-initialized" });
    for (const s of ["storage", "mint", "test"] as const) {
      expect(nextStep(s as WizardStep, alreadyInit)).toBe("done");
    }
  });

  it("shouldSkipStorageStep: only durable Upstash on the storage step (DEP-03)", () => {
    const upstash = { healthy: true, mode: "upstash" as const, durable: true };
    expect(shouldSkipStorageStep(base({ storage: upstash }))).toBe(true);
    // Not once the user has moved past (or come back via "← Storage" — the
    // shell's one-shot ref handles that; here: other steps never skip).
    expect(shouldSkipStorageStep(base({ step: "mint", storage: upstash }))).toBe(false);
    // Filesystem / memory / not-yet-durable keep the step.
    expect(
      shouldSkipStorageStep(base({ storage: { healthy: true, mode: "filesystem", durable: true } }))
    ).toBe(false);
    expect(shouldSkipStorageStep(base({ storage: { ...upstash, durable: false } }))).toBe(false);
    expect(shouldSkipStorageStep(base({ storage: { ...upstash, healthy: false } }))).toBe(false);
    expect(shouldSkipStorageStep(base({ storage: upstash, claim: "already-initialized" }))).toBe(
      false
    );
  });
});
