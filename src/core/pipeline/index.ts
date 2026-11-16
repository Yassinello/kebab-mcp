/**
 * Pipeline barrel export — PIPE-01.
 *
 * Import sites use:
 *   import { composeRequestPipeline, rehydrateStep, authStep, … } from "@/core/pipeline";
 *
 * Types live alongside:
 *   import type { PipelineContext, Step, StepNext } from "@/core/pipeline";
 *
 * Rationale: every entry-point route migrated in Tasks 3-5 pulls 3-5 of
 * these names; a barrel keeps the import surface ergonomic.
 */

export { composeRequestPipeline, PIPELINE_EXEMPT_MARKER } from "../pipeline";
export type { PipelineContext, Step, StepNext, PipelineHandler, StepResult } from "./types";

export { rehydrateStep, __resetRehydrateStepForTests } from "./rehydrate-step";
export { firstRunGateStep } from "./first-run-gate-step";
export { authStep, type AuthKind } from "./auth-step";
export { rateLimitStep, type RateLimitKeyFrom, type RateLimitStepOptions } from "./rate-limit-step";
export { hydrateCredentialsStep } from "./credentials-step";
export { bodyParseStep, type BodyParseOptions } from "./body-parse-step";
export { csrfStep } from "./csrf-step";
export { browserSessionStep, isSameOriginBrowserRequest } from "./browser-session-step";
