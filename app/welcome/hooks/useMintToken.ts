"use client";

import { useCallback, useState } from "react";

/**
 * Token-mint hook (UX-02c / Phase 45 Task 3).
 *
 * Extracted from `welcome-client.tsx` `initialize()` callback
 * (lines ~486–509): wraps POST /api/welcome/init, tracks busy /
 * error / token state, and surfaces the UX-04 `already_minted`
 * error code when a second concurrent minter loses the SETNX race
 * (see Phase 45 Task 9).
 *
 * Encapsulates: 0 useEffect + 3 useState (busy, error, token).
 */
export interface MintTokenResult {
  ok: boolean;
  token?: string;
  instanceUrl?: string;
  autoMagic?: boolean;
  envWritten?: boolean;
  redeployTriggered?: boolean;
  redeployError?: string;
  error?: string;
}

export interface UseMintTokenResult {
  mint: (opts?: { permanent?: boolean }) => Promise<MintTokenResult>;
  busy: boolean;
  error: string | null;
  token: string | null;
  instanceUrl: string | null;
  /**
   * Last full response payload (mirrors the legacy `autoMagicState`
   * UI surface so the step component can render env-written /
   * redeploy-triggered pills without a second hook).
   */
  result: MintTokenResult | null;
}

export function useMintToken(): UseMintTokenResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [instanceUrl, setInstanceUrl] = useState<string | null>(null);
  const [result, setResult] = useState<MintTokenResult | null>(null);

  const mint = useCallback(async (opts: { permanent?: boolean } = {}): Promise<MintTokenResult> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/welcome/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permanent: Boolean(opts.permanent) }),
      });
      const data = (await res.json()) as MintTokenResult;
      if (!res.ok) {
        // UX-04: 409 `already_minted` means another browser won
        // the SETNX race. Surface the error code unmodified so the
        // UI can show the specific hint ("another browser already
        // minted this instance — paste the token instead").
        const errCode =
          data.error || (res.status === 409 ? "already_minted" : `mint_failed_${res.status}`);
        setError(errCode);
        setResult(data);
        return { ok: false, error: errCode };
      }
      if (data.token) {
        setToken(data.token);
        setInstanceUrl(data.instanceUrl ?? null);
      }
      setResult(data);
      return { ...data, ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return { ok: false, error: msg };
    } finally {
      setBusy(false);
    }
  }, []);

  return { mint, busy, error, token, instanceUrl, result };
}
