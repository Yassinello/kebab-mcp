/**
 * @vitest-environment jsdom
 *
 * Kebab House phase 2 (DEP-03): a Deploy Button instance has Upstash
 * attached before the first visit, so /welcome opens on the token step.
 * Other storage modes still show the storage step.
 */
import "../components/setup";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WelcomeShell } from "../../app/welcome/WelcomeShell";

function stubFetch(storage: Record<string, unknown>) {
  vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    const body = url.includes("/api/welcome/claim")
      ? { status: "claimer" }
      : url.includes("/api/storage/status")
        ? storage
        : {};
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as unknown as Response);
  });
}

const KV = {
  mode: "kv",
  reason: "Upstash",
  dataDir: null,
  kvUrl: "https://x.upstash.io",
  error: null,
};

describe("WelcomeShell — storage step skip", () => {
  it("jumps to the token step when Upstash is already attached", async () => {
    stubFetch(KV);
    render(<WelcomeShell initialBootstrap={false} />);
    expect(await screen.findByText("Generate your auth token")).toBeInTheDocument();
    expect(screen.queryByText("Where your data lives")).not.toBeInTheDocument();
  });

  it("does not skip again after the user goes back to the storage step", async () => {
    stubFetch(KV);
    render(<WelcomeShell initialBootstrap={false} />);
    await screen.findByText("Generate your auth token");
    fireEvent.click(screen.getByRole("button", { name: /← storage/i }));
    expect(await screen.findByText("Where your data lives")).toBeInTheDocument();
    // Give the effects a chance to (wrongly) re-skip.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("Where your data lives")).toBeInTheDocument();
  });

  it("keeps the storage step when Upstash is attached but unreachable", async () => {
    stubFetch({ ...KV, mode: "kv-degraded", error: "ping timeout" });
    render(<WelcomeShell initialBootstrap={false} />);
    expect(await screen.findByText("Where your data lives")).toBeInTheDocument();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByText("Generate your auth token")).not.toBeInTheDocument();
  });

  it("keeps the storage step when there is no KV (memory / static)", async () => {
    stubFetch({ mode: "static", reason: "no KV", dataDir: null, kvUrl: null, error: null });
    render(<WelcomeShell initialBootstrap={false} />);
    expect(await screen.findByText("Where your data lives")).toBeInTheDocument();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByText("Generate your auth token")).not.toBeInTheDocument();
  });
});
