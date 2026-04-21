"use client";

import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";
import type {
  WelcomeState as WizardWelcomeState,
  WizardStep,
  WizardStorageSummary,
} from "./wizard-steps";

/**
 * WelcomeStateContext — reducer-backed state machine for the welcome
 * wizard (Phase 45 Task 4, UX-01a).
 *
 * Extends the minimal `WelcomeState` shape exported from
 * `wizard-steps.ts` with the full operator-state this wizard needs:
 * errors, busy flags, ack for non-ideal storage modes, last-check
 * outcome for the Upstash poll loop.
 *
 * Dormant in this commit — `WelcomeShell` (Task 5) will opt individual
 * step components into `useWelcomeState()` / `useWelcomeDispatch()`
 * incrementally. `welcome-client.tsx` (Task 5) still owns the legacy
 * useState chain until the step components opt in; both code paths
 * coexist during the migration.
 *
 * Reducer design:
 *   - All 10 actions are discriminated union variants so TS flags any
 *     missing case in the switch statement.
 *   - No async inside the reducer — side effects live in the 3 hooks
 *     (useClaimStatus, useStoragePolling, useMintToken) and dispatch
 *     terminal actions (CLAIM_RESOLVED, STORAGE_UPDATED, TOKEN_MINTED,
 *     etc.) with the resolved values.
 *   - Derivable state (isTerminal, canAdvance) lives in wizard-steps.ts
 *     and is recomputed on each render via useMemo.
 */

export type AckValue = "static" | "ephemeral" | null;
export type AutoMagicState = {
  autoMagic: boolean;
  envWritten: boolean;
  redeployTriggered: boolean;
  redeployError?: string;
};

/** Full wizard state. Extends the minimal shape from wizard-steps.ts. */
export interface WelcomeState extends WizardWelcomeState {
  instanceUrl: string;
  ack: AckValue;
  ackPersisted: boolean;
  autoMagic: AutoMagicState | null;
  testStatus: "idle" | "testing" | "ok" | "fail";
  testError: string | null;
  permanent: boolean;
  busy: boolean;
  error: string | null;
}

export type WelcomeAction =
  | { type: "CLAIM_RESOLVED"; claim: WizardWelcomeState["claim"] }
  | { type: "STORAGE_UPDATED"; storage: WizardStorageSummary }
  | { type: "ACK_SET"; value: AckValue; persisted: boolean }
  | { type: "STEP_SET"; step: WizardStep }
  | {
      type: "TOKEN_MINTED";
      token: string;
      instanceUrl: string;
      autoMagic: AutoMagicState | null;
    }
  | { type: "TOKEN_SAVED_SET"; tokenSaved: boolean }
  | { type: "PERMANENT_SET"; permanent: boolean }
  | { type: "TEST_STARTED" }
  | { type: "TEST_RESOLVED"; ok: boolean; error?: string }
  | { type: "ERROR_SET"; error: string | null }
  | { type: "BUSY_SET"; busy: boolean };

export const initialWelcomeState: WelcomeState = {
  // Wizard-level
  claim: "loading",
  step: "storage",
  token: null,
  tokenSaved: false,
  storage: { healthy: false, mode: "memory" },
  // Extension fields
  instanceUrl: "",
  ack: null,
  ackPersisted: true,
  autoMagic: null,
  testStatus: "idle",
  testError: null,
  permanent: false,
  busy: false,
  error: null,
};

export function welcomeReducer(state: WelcomeState, action: WelcomeAction): WelcomeState {
  switch (action.type) {
    case "CLAIM_RESOLVED":
      return { ...state, claim: action.claim };
    case "STORAGE_UPDATED":
      return { ...state, storage: action.storage };
    case "ACK_SET":
      return { ...state, ack: action.value, ackPersisted: action.persisted };
    case "STEP_SET":
      return { ...state, step: action.step };
    case "TOKEN_MINTED":
      return {
        ...state,
        token: action.token,
        instanceUrl: action.instanceUrl,
        autoMagic: action.autoMagic,
      };
    case "TOKEN_SAVED_SET":
      return { ...state, tokenSaved: action.tokenSaved };
    case "PERMANENT_SET":
      return { ...state, permanent: action.permanent };
    case "TEST_STARTED":
      return { ...state, testStatus: "testing", testError: null };
    case "TEST_RESOLVED":
      return {
        ...state,
        testStatus: action.ok ? "ok" : "fail",
        testError: action.ok ? null : (action.error ?? "MCP test failed"),
      };
    case "ERROR_SET":
      return { ...state, error: action.error };
    case "BUSY_SET":
      return { ...state, busy: action.busy };
  }
}

type Dispatch = (action: WelcomeAction) => void;

const WelcomeStateCtx = createContext<WelcomeState | null>(null);
const WelcomeDispatchCtx = createContext<Dispatch | null>(null);

export interface WelcomeStateProviderProps {
  initial?: Partial<WelcomeState>;
  children: ReactNode;
}

export function WelcomeStateProvider({
  initial,
  children,
}: WelcomeStateProviderProps): React.JSX.Element {
  const [state, dispatch] = useReducer(welcomeReducer, {
    ...initialWelcomeState,
    ...initial,
  });
  // Memoize so child consumers don't re-render on parent renders that
  // don't change state reference.
  const stateValue = useMemo(() => state, [state]);
  return (
    <WelcomeStateCtx.Provider value={stateValue}>
      <WelcomeDispatchCtx.Provider value={dispatch}>{children}</WelcomeDispatchCtx.Provider>
    </WelcomeStateCtx.Provider>
  );
}

export function useWelcomeState(): WelcomeState {
  const v = useContext(WelcomeStateCtx);
  if (v === null) throw new Error("useWelcomeState must be used inside <WelcomeStateProvider>");
  return v;
}

export function useWelcomeDispatch(): Dispatch {
  const v = useContext(WelcomeDispatchCtx);
  if (v === null) throw new Error("useWelcomeDispatch must be used inside <WelcomeStateProvider>");
  return v;
}
