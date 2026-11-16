/**
 * 2026-11 audit (B2) — "Import GitHub vault into KV" keeps notes that exist
 * in both unless "Overwrite notes that exist in both" is ticked, and then
 * asks for confirmation first. The report shows imported / overwritten / kept.
 */
/// <reference lib="dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { VaultBackendPanel } from "@/../app/config/tabs/vault-backend-panel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const REPORT = {
  totalFiles: 3,
  copied: 1,
  overwritten: 0,
  keptCount: 1,
  kept: ["Notes/b.md"],
  unchanged: 1,
  skippedCount: 0,
  tooLargeCount: 0,
  failedCount: 0,
  incomplete: false,
  remaining: 0,
  tooLarge: [],
  failed: [],
};

let posts: Array<Record<string, unknown>> = [];

beforeEach(() => {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ ok: true, report: REPORT });
      }
      return jsonResponse({
        ok: true,
        backend: "github",
        reason: "github-credentials",
        githubConfigured: true,
        kv: { notes: 2, totalBytes: 2048 },
      });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VaultBackendPanel import", () => {
  it("imports without overwriting by default and reports kept notes", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<VaultBackendPanel />);
    fireEvent.click(await screen.findByText("Import GitHub vault into KV"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ action: "import-github", overwrite: false });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await screen.findByText(/1 imported, 0 overwritten,/)).toBeInTheDocument();
    expect(screen.getByText(/Kept as they are here: Notes\/b\.md/)).toBeInTheDocument();
  });

  it("asks for confirmation when overwrite is ticked; cancelling sends nothing", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<VaultBackendPanel />);
    fireEvent.click(await screen.findByLabelText(/Overwrite notes that exist in both/));
    fireEvent.click(screen.getByText("Import GitHub vault into KV"));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(0);

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByText("Import GitHub vault into KV"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ action: "import-github", overwrite: true });
  });
});
