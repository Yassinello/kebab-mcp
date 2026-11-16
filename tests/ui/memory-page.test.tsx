/**
 * 2026-11 audit (C1.3): the Memory page — folders with counts, notes,
 * search, reading a note as text (never as HTML), provenance, delete with
 * confirmation, and the empty state.
 */
/// <reference lib="dom" />
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryTab } from "@/../app/config/tabs/memory";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';

function stubMemory(totalNotes = 3) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "DELETE") return Promise.resolve(json({ ok: true, path: "Inbox/idea.md" }));
      if (url.includes("view=folders")) {
        return Promise.resolve(
          json({
            backend: "kv",
            totalNotes,
            folders:
              totalNotes === 0
                ? []
                : [
                    { path: "Inbox", count: 2 },
                    { path: "Projects", count: 1 },
                  ],
          })
        );
      }
      if (url.includes("folder=Inbox")) {
        return Promise.resolve(
          json({
            total: 2,
            notes: [
              { path: "Inbox/idea.md", name: "idea.md", size: 40, updatedAt: null },
              { path: "Inbox/link.md", name: "link.md", size: 20, updatedAt: null },
            ],
          })
        );
      }
      if (url.includes("q=")) {
        return Promise.resolve(
          json({
            totalCount: 1,
            truncated: false,
            results: [
              {
                path: "Projects/plan.md",
                name: "plan.md",
                snippet: "the kebab plan",
                provenance: "user",
              },
            ],
          })
        );
      }
      if (url.includes("path=")) {
        return Promise.resolve(
          json({
            path: "Inbox/idea.md",
            name: "idea.md",
            size: 120,
            content: `# Idea\n${HOSTILE}`,
            provenance: "external",
            updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            change: { message: "Saved from a web page", author: "Kebab House" },
          })
        );
      }
      return Promise.resolve(json({}));
    })
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as { __pwned?: number }).__pwned;
});

describe("<MemoryTab />", () => {
  it("shows the empty state when nothing is saved", async () => {
    stubMemory(0);
    render(<MemoryTab />);
    const empty = await screen.findByTestId("memory-empty");
    expect(empty).toHaveTextContent("Nothing saved yet.");
    expect(empty).toHaveTextContent("Say “remember that…” in any connected AI client.");
  });

  it("lists folders with counts and opens the first one", async () => {
    stubMemory();
    render(<MemoryTab />);
    expect(await screen.findByText("3 notes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Projects\s*1/ })).toBeInTheDocument();
    expect(await screen.findByText("idea.md")).toBeInTheDocument();
    expect(screen.getByText("link.md")).toBeInTheDocument();
  });

  it("reads a note as plain text with its provenance and last change", async () => {
    stubMemory();
    render(<MemoryTab />);
    fireEvent.click(await screen.findByText("idea.md"));
    const pre = await screen.findByTestId("note-content");
    // The hostile markup is shown as text, never parsed into elements.
    expect(pre.textContent).toContain(HOSTILE);
    expect(pre.querySelector("img, script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.getByText("From the web")).toBeInTheDocument();
    expect(screen.getByText(/Last changed 5m ago · Saved from a web page/)).toBeInTheDocument();
  });

  it("searches through the API", async () => {
    const calls = stubMemory();
    render(<MemoryTab />);
    await screen.findByText("idea.md");
    fireEvent.change(screen.getByLabelText("Search your notes"), { target: { value: "kebab" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("the kebab plan")).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith("/api/config/memory?q=kebab"))).toBe(true);
  });

  it("deletes a note only after confirmation", async () => {
    const calls = stubMemory();
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    render(<MemoryTab />);
    fireEvent.click(await screen.findByText("idea.md"));
    await screen.findByTestId("note-content");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(calls.find((c) => c.method === "DELETE")!.url).toBe(
      "/api/config/memory?path=Inbox%2Fidea.md"
    );
    expect(await screen.findByText("Deleted Inbox/idea.md.")).toBeInTheDocument();
  });
});
