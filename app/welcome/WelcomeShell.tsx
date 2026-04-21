"use client";

import { useCallback, useEffect } from "react";
import {
  WelcomeStateProvider,
  useWelcomeDispatch,
  useWelcomeState,
  type WelcomeState,
} from "./WelcomeStateContext";
import { StorageStep } from "./steps/storage";
import { MintStep } from "./steps/mint";
import { TestStep } from "./steps/test";
import { AlreadyInitializedPanel } from "./steps/already-initialized";
import { useClaimStatus } from "./hooks/useClaimStatus";
import {
  PreviewBanner,
  RecoveryFooter,
  RecoveryResetBanner,
  Shell,
  WizardStepper,
  type WizardStep,
} from "./chrome";

/**
 * WelcomeShell — Phase 47 orchestrator (WIRE-03 + WIRE-04). Reducer-
 * driven step router, zero useState. Step JSX lives in
 * `./steps/{storage,mint,test,already-initialized}.tsx`; chrome in
 * `./chrome.tsx`; state in `./WelcomeStateContext.tsx`.
 */

interface WelcomeClientProps {
  initialBootstrap: boolean;
  /** MYMCP_RECOVERY_RESET=1 banner: minting now hands the user a doomed credential. */
  recoveryResetActive?: boolean;
  previewMode?: boolean;
  previewToken?: string;
  previewInstanceUrl?: string;
}

export type { WelcomeClientProps };

function deriveProviderInitial(props: WelcomeClientProps): Partial<WelcomeState> {
  return {
    claim: props.previewMode ? "claimer" : "loading",
    step: "storage",
    token: props.previewMode ? (props.previewToken ?? null) : null,
    instanceUrl: props.previewMode ? (props.previewInstanceUrl ?? "") : "",
    tokenSaved: Boolean(props.initialBootstrap),
    permanent: Boolean(props.previewMode),
  };
}

export function WelcomeShell(props: WelcomeClientProps) {
  return (
    <WelcomeStateProvider initial={deriveProviderInitial(props)}>
      <WelcomeShellBody {...props} />
    </WelcomeStateProvider>
  );
}

function WelcomeShellBody({
  initialBootstrap,
  recoveryResetActive = false,
  previewMode = false,
  previewToken = "",
  previewInstanceUrl = "",
}: WelcomeClientProps) {
  const state = useWelcomeState();
  const dispatch = useWelcomeDispatch();

  // Reducer uses "storage"|"mint"|"test"|"done"; stepper takes 1|2|3.
  const step: WizardStep = state.step === "storage" ? 1 : state.step === "mint" ? 2 : 3;
  const setStep = useCallback(
    (next: WizardStep) => {
      dispatch({
        type: "STEP_SET",
        step: next === 1 ? "storage" : next === 2 ? "mint" : "test",
      });
    },
    [dispatch]
  );

  // Claim hook → reducer bridge.
  const claimHook = useClaimStatus(previewMode ? "claimer" : "loading");
  const claim = previewMode ? "claimer" : claimHook.claim;
  useEffect(() => {
    if (previewMode) return;
    if (claim === "loading") return;
    if (claim === "new" || claim === "claimer") {
      dispatch({ type: "CLAIM_RESOLVED", claim: "claimer" });
    } else if (claim === "already-initialized") {
      dispatch({ type: "CLAIM_RESOLVED", claim: "already-initialized" });
    }
  }, [claim, previewMode, dispatch]);
  useEffect(() => {
    if (claimHook.error) {
      dispatch({ type: "ERROR_SET", error: "Could not reach this instance. Try refreshing." });
    }
  }, [claimHook.error, dispatch]);

  // Derived flags (reducer is truth).
  const storageReady = state.storage.healthy;
  const durableBackend = Boolean(state.storage.durable);
  const persistenceReady = state.permanent || durableBackend;
  // Translate reducer mode (upstash|filesystem|memory) → MintStep's legacy kv|file|static|null.
  const legacyStorageMode =
    state.storage.mode === "upstash"
      ? ("kv" as const)
      : state.storage.mode === "filesystem"
        ? ("file" as const)
        : state.storage.mode === "memory" && state.storage.healthy
          ? ("static" as const)
          : null;
  const legacyStorageEphemeral = state.storage.mode === "filesystem" && !state.storage.durable;

  // ── Render branches ─────────────────────────────────────────────────

  if (claim === "loading") {
    return (
      <Shell>
        <p className="text-slate-400">Connecting to this instance…</p>
      </Shell>
    );
  }

  if (claim === "already-initialized") {
    return (
      <Shell>
        <AlreadyInitializedPanel skipClaimSync />
        <RecoveryFooter />
      </Shell>
    );
  }

  if (claim === "claimed-by-other") {
    return (
      <Shell>
        <h1 className="text-2xl font-bold text-white mb-2">Instance locked</h1>
        <p className="text-slate-400">
          Another browser is currently initializing this instance. Wait for them to finish, or
          contact the operator who deployed it.
        </p>
      </Shell>
    );
  }

  // claim === "new"|"claimer": render the 3-step wizard.
  // step 1 = Storage; step 2 = Auth token; step 3 = Connect.
  return (
    <Shell wide>
      {previewMode && <PreviewBanner />}
      {recoveryResetActive && <RecoveryResetBanner />}

      <WizardStepper
        current={step}
        storageReady={Boolean(storageReady)}
        tokenSavedConfirmed={Boolean(state.token) && state.tokenSaved && persistenceReady}
        testOk={state.testStatus === "ok"}
        onGoTo={(target) => {
          if (target < step) {
            setStep(target);
            return;
          }
          if (target === 2 && storageReady) setStep(2);
          else if (target === 3 && storageReady && state.tokenSaved && persistenceReady) setStep(3);
        }}
      />

      <div className="mt-8">
        {step === 1 && <StorageStep onContinue={() => setStep(2)} />}
        {step === 2 && (
          <MintStep
            initialBootstrap={initialBootstrap}
            previewMode={previewMode}
            previewToken={previewToken}
            previewInstanceUrl={previewInstanceUrl}
            recoveryResetActive={recoveryResetActive}
            onBack={() => setStep(1)}
            onContinue={() => setStep(3)}
            storageMode={legacyStorageMode}
            storageEphemeral={legacyStorageEphemeral}
          />
        )}
        {step === 3 && <TestStep durableBackend={durableBackend} onBack={() => setStep(2)} />}
      </div>

      <RecoveryFooter />
    </Shell>
  );
}
