/**
 * @vitest-environment jsdom
 */
import "../components/setup";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useMintToken } from "../../app/welcome/hooks/useMintToken";

describe("useMintToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POSTs /api/welcome/init with { action: 'mint' } style body when mint() is called", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, token: "t-123", instanceUrl: "https://e.com" }),
    } as unknown as Response);

    const { result } = renderHook(() => useMintToken());

    await act(async () => {
      await result.current.mint();
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toMatch(/\/api\/welcome\/init/);
    expect((init as RequestInit | undefined)?.method).toBe("POST");
  });

  it("sets busy=true during the call, false after resolution", async () => {
    let resolver: ((v: unknown) => void) | undefined;
    const pending = new Promise((res) => {
      resolver = res;
    });
    vi.mocked(globalThis.fetch).mockReturnValue(
      pending.then(
        () =>
          ({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ ok: true, token: "t", instanceUrl: "https://e.com" }),
          }) as unknown as Response
      ) as unknown as Promise<Response>
    );

    const { result } = renderHook(() => useMintToken());
    expect(result.current.busy).toBe(false);

    let mintPromise: Promise<unknown> | undefined;
    act(() => {
      mintPromise = result.current.mint();
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    resolver?.({});
    await act(async () => {
      await mintPromise;
    });
    expect(result.current.busy).toBe(false);
  });

  it("exposes token via state on 200 response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ ok: true, token: "minted-token", instanceUrl: "https://e.com" }),
    } as unknown as Response);

    const { result } = renderHook(() => useMintToken());
    await act(async () => {
      await result.current.mint();
    });
    expect(result.current.token).toBe("minted-token");
    expect(result.current.error).toBeNull();
  });

  it("exposes error='already_minted' on 409 response (UX-04 path)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: "already_minted" }),
    } as unknown as Response);

    const { result } = renderHook(() => useMintToken());
    await act(async () => {
      await result.current.mint();
    });
    expect(result.current.token).toBeNull();
    expect(result.current.error).toBe("already_minted");
  });

  it("exposes error message on network error", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useMintToken());
    await act(async () => {
      await result.current.mint();
    });
    expect(result.current.error).not.toBeNull();
    expect(result.current.token).toBeNull();
  });
});
