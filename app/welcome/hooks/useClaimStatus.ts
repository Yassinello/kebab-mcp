"use client";

import { useCallback, useEffect, useState } from "react";
import { toMsg } from "@/core/error-utils";

/**
 * Claim-status hook (UX-02c / Phase 45 Task 3).
 *
 * Extracted from `welcome-client.tsx` lines ~207–268: issues a single
 * POST /api/welcome/claim on mount to establish whether this browser
 * is the first-run claimer, is waiting behind another claimer, or is
 * hitting an instance that was already initialized.
 *
 * Encapsulates: 1 useEffect (mount + unmount-abort) + 3 useState
 * (claim, error, refetchToken). Uses AbortController so a fast
 * unmount does not leak a setState-on-unmounted warning. Callers
 * trigger a re-fetch via `refetch()` (e.g. after the user clicks
 * "I added Upstash — recheck").
 */
export type ClaimStatus =
  | "loading"
  | "new"
  | "claimer"
  | "claimed-by-other"
  | "already-initialized";

export interface UseClaimStatusResult {
  claim: ClaimStatus;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useClaimStatus(initialClaim: ClaimStatus = "loading"): UseClaimStatusResult {
  const [claim, setClaim] = useState<ClaimStatus>(initialClaim);
  const [error, setError] = useState<string | null>(null);
  // A token that `refetch()` flips to force a new run of the effect.
  const [fetchNonce, setFetchNonce] = useState(0);

  const refetch = useCallback(async (): Promise<void> => {
    setFetchNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/welcome/claim", {
          method: "POST",
          signal: controller.signal,
        });
        if (cancelled) return;
        const data = (await res.json()) as { status?: ClaimStatus; error?: string };
        if (cancelled) return;
        if (res.ok && data.status) {
          setClaim(data.status);
          setError(null);
        } else {
          // Non-OK — either an error body or an already-initialized
          // signal that arrived as a non-2xx. Fall back to a generic
          // message; the UI's error ribbon is the surface.
          setError(data.error || `claim request failed: ${res.status}`);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setError(toMsg(err));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetchNonce]);

  return { claim, error, refetch };
}
