"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Storage-status polling hook (UX-02c / Phase 45 Task 3).
 *
 * Extracted from `welcome-client.tsx` lines ~289–366: drives the
 * /api/storage/status poll loop, tracks consecutive failures, and
 * stops polling once the failure cap is reached (matches the
 * pre-refactor escape-hatch semantics).
 *
 * Encapsulates: 1 useEffect (poll-loop lifecycle) + 4 useState
 * (storageStatus, checking, failures, active). Uses refs to avoid
 * re-creating the interval when local state flips; uses
 * AbortController for in-flight fetch cancellation on unmount.
 */
export interface StorageStatus {
  mode: "kv" | "file" | "static" | "kv-degraded" | "upstash" | "filesystem" | "memory";
  reason?: string;
  dataDir?: string | null;
  kvUrl?: string | null;
  error?: string | null;
  ephemeral?: boolean;
  detectedAt?: string;
}

export interface UseStoragePollingOptions {
  /** Poll cadence in ms. Default: 2000 (2 s). */
  intervalMs?: number;
  /** Max consecutive failures before the loop auto-stops. Default: 5. */
  failureCap?: number;
  /** Start the loop immediately. Default: true. */
  autoStart?: boolean;
}

export interface UseStoragePollingResult {
  storageStatus: StorageStatus | null;
  checking: boolean;
  failures: number;
  start: () => void;
  stop: () => void;
  refetch: () => Promise<void>;
}

export function useStoragePolling(opts: UseStoragePollingOptions = {}): UseStoragePollingResult {
  const intervalMs = opts.intervalMs ?? 2000;
  const failureCap = opts.failureCap ?? 5;
  const autoStart = opts.autoStart ?? true;

  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [failures, setFailures] = useState(0);
  const [active, setActive] = useState<boolean>(autoStart);

  // Use a ref-backed failure counter so the poll loop sees the latest
  // value without reinstalling the interval on every increment (that
  // pattern was a known StrictMode double-fire source in v2).
  const failuresRef = useRef(0);
  useEffect(() => {
    failuresRef.current = failures;
  }, [failures]);

  const fetchOnce = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setChecking(true);
    try {
      const res = await fetch("/api/storage/status", {
        credentials: "include",
        signal,
      });
      if (!res.ok) {
        setFailures((n) => n + 1);
        return;
      }
      const data = (await res.json()) as StorageStatus;
      setStorageStatus(data);
      setFailures(0);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setFailures((n) => n + 1);
    } finally {
      setChecking(false);
    }
  }, []);

  const start = useCallback(() => setActive(true), []);
  const stop = useCallback(() => setActive(false), []);
  const refetch = useCallback(async (): Promise<void> => {
    await fetchOnce();
  }, [fetchOnce]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();

    // Fire one fetch immediately so the first paint has data.
    void fetchOnce(controller.signal);

    const id = setInterval(() => {
      // Stop polling at the failure cap — callers can still call
      // refetch() manually to probe once more.
      if (failuresRef.current >= failureCap) {
        clearInterval(id);
        return;
      }
      void fetchOnce(controller.signal);
    }, intervalMs);

    return () => {
      clearInterval(id);
      controller.abort();
    };
  }, [active, intervalMs, failureCap, fetchOnce]);

  return { storageStatus, checking, failures, start, stop, refetch };
}
