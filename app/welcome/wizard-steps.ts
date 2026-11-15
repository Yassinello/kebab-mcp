/**
 * Welcome wizard — step ordering + gate predicates.
 *
 * Extracted in Phase 45 Task 2 (UX-02b) from the inline `WizardStep`
 * state machine in `app/welcome/welcome-client.tsx` so the truth-table
 * is directly unit-testable (see `tests/ui/wizard-steps.test.ts`) and
 * the step order is declared in one place rather than threaded through
 * JSX conditionals.
 *
 * This module is PURE — no React imports, no DOM access, no fetch. It
 * deliberately carries only a minimal `WelcomeState` shape; the full
 * state machine is defined in `WelcomeStateContext.tsx` (Task 4) and
 * extends this shape with reducer-specific fields (errors, busy flags,
 * ack, etc.). The predicates here answer "can we advance?" given just
 * the wizard-relevant slice of state.
 */

/**
 * Wizard steps in order. `"done"` is the sink state — the wizard has
 * no UI past this point; the user is routed to /config.
 */
export type WizardStep = "storage" | "mint" | "test" | "done";

/**
 * Frozen, ordered step array. Imported by `WelcomeShell` to render the
 * progress stepper and by the reducer to walk forward.
 *
 * `as const` locks the tuple types at compile time; `Object.freeze`
 * locks the reference at runtime so test asserters can trust the
 * ordering.
 */
export const STEPS: readonly WizardStep[] = Object.freeze([
  "storage",
  "mint",
  "test",
  "done",
]) as readonly WizardStep[];

/**
 * Storage-detection summary consumed by the mint gate. Mirrors the
 * shape of the full `StorageStatus` in `WelcomeStateContext` but
 * carries only the fields this module needs.
 *
 * `durable` is stricter than `healthy`: `healthy` allows acked-ephemeral
 * ("user explicitly accepted /tmp"), while `durable` requires actual
 * persistence across cold starts. The mint + test steps read `durable`
 * to decide whether the token survives without a Vercel env-var write.
 * Optional because v0 test fixtures don't construct it; `canAdvanceTo*`
 * predicates only read `healthy` / `mode`.
 */
export interface WizardStorageSummary {
  healthy: boolean;
  mode: "upstash" | "filesystem" | "memory";
  /** True when the backend persists across cold starts (kv OR non-ephemeral file). Phase 47 WIRE-01a. */
  durable?: boolean;
}

/**
 * Claim-status state consumed by the terminal predicate.
 */
export type WizardClaim = "claimer" | "waiting" | "already-initialized" | "loading";

/**
 * Minimal state shape for gate predicates. The full WelcomeState (in
 * WelcomeStateContext.tsx) extends this.
 */
export interface WelcomeState {
  claim: WizardClaim;
  step: WizardStep;
  token: string | null;
  tokenSaved: boolean;
  storage: WizardStorageSummary;
}

/**
 * Gate: can we leave the storage step?
 *
 * Predicate: storage is healthy AND mode !== memory. Memory mode works
 * for the warm lambda but every cold start wipes it; minting a token
 * there hands the user a doomed credential. The UI covers ack'd
 * ephemeral file mode via a separate path; memory is hard-blocked
 * because there's no ack that makes it safe.
 */
export function canAdvanceToMint(state: WelcomeState): boolean {
  return state.storage.healthy && state.storage.mode !== "memory";
}

/**
 * Kebab House phase 2 (DEP-03): skip the storage step automatically?
 *
 * A Deploy Button instance arrives with Upstash already attached (the
 * button's `stores` parameter), so there is nothing to choose on the
 * storage step. When the first detection says durable Upstash, the wizard
 * opens on the token step instead. Filesystem / memory / degraded KV keep
 * the step: the operator has a decision (or a warning) to see there.
 * Only from the storage step — never once the user has moved on.
 */
export function shouldSkipStorageStep(state: WelcomeState): boolean {
  return (
    state.claim !== "already-initialized" &&
    state.step === "storage" &&
    state.storage.mode === "upstash" &&
    state.storage.healthy &&
    state.storage.durable === true
  );
}

/**
 * Gate: can we leave the mint step?
 *
 * Predicate: a token was minted AND the user checked the "I saved it"
 * box. No predicate can verify the user really did save the token —
 * this is an explicit consent gate, not a security boundary.
 */
export function canAdvanceToTest(state: WelcomeState): boolean {
  return state.token !== null && state.tokenSaved;
}

/**
 * Predicate: is the wizard finished?
 *
 * True when the explicit `step === "done"` sink is reached, OR when
 * the instance was already initialized before the user opened
 * /welcome (routed to AlreadyInitializedPanel, which is terminal).
 */
export function isTerminal(state: WelcomeState): boolean {
  return state.step === "done" || state.claim === "already-initialized";
}

/**
 * Compute the next step given current step + state. Callers use this
 * to decide whether a "Continue" click advances, or whether the gate
 * predicate blocks the advance (the user stays on the same step).
 *
 * Claim-state short-circuit: if the claim resolves to
 * already-initialized mid-flow (the user's claim cookie was taken
 * over by another browser, or the instance flipped to initialized
 * state via a different handler), the UI must fall through to
 * AlreadyInitializedPanel — expressed here as "done".
 */
export function nextStep(current: WizardStep, state: WelcomeState): WizardStep {
  if (state.claim === "already-initialized") return "done";
  switch (current) {
    case "storage":
      return canAdvanceToMint(state) ? "mint" : "storage";
    case "mint":
      return canAdvanceToTest(state) ? "test" : "mint";
    case "test":
      return "done";
    case "done":
      return "done";
  }
}
