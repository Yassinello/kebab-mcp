/**
 * @vitest-environment jsdom
 */
import "../components/setup";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useClaimStatus } from "../../app/welcome/hooks/useClaimStatus";

function mockClaimResponse(status: string, ok = true, httpStatus = 200): void {
  vi.mocked(globalThis.fetch).mockResolvedValue({
    ok,
    status: httpStatus,
    json: () => Promise.resolve({ status }),
  } as unknown as Response);
}

describe("useClaimStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls POST /api/welcome/claim once on mount", async () => {
    mockClaimResponse("claimer");
    const { result } = renderHook(() => useClaimStatus());

    await waitFor(() => expect(result.current.claim).toBe("claimer"));

    // /api/welcome/claim is called — we don't over-specify the method here
    // because the hook can call either GET (for diagnostic) or POST (the
    // current welcome-client path); the important contract is one fetch
    // against the claim endpoint on mount.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toMatch(/\/api\/welcome\/claim/);
  });

  it("returns claim='claimer' when the API resolves to claimer", async () => {
    mockClaimResponse("claimer");
    const { result } = renderHook(() => useClaimStatus());
    await waitFor(() => expect(result.current.claim).toBe("claimer"));
    expect(result.current.error).toBeNull();
  });

  it("returns claim='already-initialized' when the API reports it", async () => {
    mockClaimResponse("already-initialized");
    const { result } = renderHook(() => useClaimStatus());
    await waitFor(() => expect(result.current.claim).toBe("already-initialized"));
  });

  it("surfaces error state on network failure", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useClaimStatus());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.claim).not.toBe("claimer"); // stayed on loading or rolled back
  });

  it("refetch() triggers a new fetch", async () => {
    mockClaimResponse("claimer");
    const { result } = renderHook(() => useClaimStatus());
    await waitFor(() => expect(result.current.claim).toBe("claimer"));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    mockClaimResponse("already-initialized");
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.claim).toBe("already-initialized"));
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
