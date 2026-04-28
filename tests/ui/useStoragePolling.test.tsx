/**
 * @vitest-environment jsdom
 */
import "../components/setup";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useStoragePolling } from "../../app/welcome/hooks/useStoragePolling";

function mockStorageResponse(
  body: Record<string, unknown> = { mode: "kv", reason: "ok" },
  ok = true
): void {
  vi.mocked(globalThis.fetch).mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

describe("useStoragePolling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches /api/storage/status on mount", async () => {
    mockStorageResponse({ mode: "kv", reason: "ok", dataDir: null, kvUrl: null, error: null });
    const { result } = renderHook(() => useStoragePolling({ intervalMs: 2000 }));

    await waitFor(() => expect(result.current.storageStatus?.mode).toBe("kv"));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call).toBeDefined();
    const [url] = call!;
    expect(String(url)).toMatch(/\/api\/storage\/status/);
  });

  it("exposes storageStatus, checking, and failures", async () => {
    mockStorageResponse({ mode: "file", reason: "ok", dataDir: "/tmp", kvUrl: null, error: null });
    const { result } = renderHook(() => useStoragePolling({ intervalMs: 2000 }));

    await waitFor(() => expect(result.current.storageStatus).not.toBeNull());
    expect(result.current.failures).toBe(0);
    expect(typeof result.current.checking).toBe("boolean");
  });

  it("increments failures on fetch error; stops polling after 5 consecutive failures", async () => {
    // All fetches fail.
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useStoragePolling({ intervalMs: 100 }));

    // Drive enough ticks to accumulate 5 failures.
    await waitFor(() => expect(result.current.failures).toBeGreaterThanOrEqual(1), {
      timeout: 500,
    });
    // Advance the clock to let the poll loop fire more times.
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
    }
    await waitFor(() => expect(result.current.failures).toBeGreaterThanOrEqual(5), {
      timeout: 1000,
    });
    // Sample the call count at the failure-cap point, then drive more time
    // and assert no new fetches. The hook stopped polling.
    const callsAtCap = vi.mocked(globalThis.fetch).mock.calls.length;
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    }
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeLessThanOrEqual(callsAtCap + 1);
  });

  it("start() / stop() explicit controls work", async () => {
    mockStorageResponse({ mode: "kv", reason: "ok" });
    const { result } = renderHook(() => useStoragePolling({ intervalMs: 50 }));
    await waitFor(() => expect(result.current.storageStatus).not.toBeNull());

    act(() => {
      result.current.stop();
    });
    const callsAfterStop = vi.mocked(globalThis.fetch).mock.calls.length;
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    // No new fetches after stop().
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(callsAfterStop);

    act(() => {
      result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(callsAfterStop);
  });
});
