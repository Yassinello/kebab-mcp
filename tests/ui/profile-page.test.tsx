/**
 * 2026-11 audit (C1.2 / C1.4): the Profile page — one Save button, status
 * line, empty state with the guided-setup phrase, history with restore,
 * and "Your data" export / import.
 */
/// <reference lib="dom" />
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ProfileTab } from "@/../app/config/tabs/profile";
import { ImportReportView, YourDataSection } from "@/../app/config/tabs/your-data";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubApi(opts: { inline: string; info?: Record<string, unknown>; history?: unknown[] }) {
  const calls: Call[] = [];
  let inline = opts.inline;
  const history = [...(opts.history ?? [])] as { content: string }[];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = init?.method ?? "GET";
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep raw */
      }
    }
    calls.push({ url, method, body });
    if (url.startsWith("/api/config/context")) {
      return Promise.resolve(json({ mode: "inline", inline, vaultPath: "System/context.md" }));
    }
    if (url.startsWith("/api/config/profiles")) {
      if (method === "PUT") {
        inline = (body as { content: string }).content;
        return Promise.resolve(json({ ok: true, name: "default" }));
      }
      if (method === "POST") {
        const idx = (body as { index: number }).index;
        const prev = inline;
        inline = history[idx]!.content;
        history.unshift({ content: prev });
        return Promise.resolve(json({ ok: true }));
      }
      if (url.includes("history=1")) return Promise.resolve(json({ name: "default", history }));
      if (url.includes("name=default")) {
        return Promise.resolve(
          json({ name: "default", content: inline, bytes: inline.length, ...(opts.info ?? {}) })
        );
      }
      return Promise.resolve(json({ profiles: [] }));
    }
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<ProfileTab />", () => {
  it("explains the guided setup when the profile is empty", async () => {
    stubApi({ inline: "" });
    render(<ProfileTab vaultEnabled={true} initialPath="System/context.md" />);
    expect(await screen.findByText("Your profile is empty.")).toBeInTheDocument();
    expect(screen.getByText(/Set up my Kebab House/)).toBeInTheDocument();
    // One Save button for the profile, disabled until something changes.
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(await screen.findByText(/No earlier version yet/)).toBeInTheDocument();
  });

  it("shows size, last update and author, and saves through the profiles API", async () => {
    const calls = stubApi({
      inline: "# Me",
      info: { updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), by: "Claude" },
    });
    render(<ProfileTab vaultEnabled={true} initialPath="System/context.md" />);
    expect(await screen.findByTestId("profile-status")).toHaveTextContent(
      "4 B · updated 3h ago by Claude"
    );
    fireEvent.change(screen.getByLabelText("Profile text"), { target: { value: "# Me\nmore" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url === "/api/config/profiles")).toBe(true)
    );
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ name: "default", content: "# Me\nmore" });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("lists the history, shows a version and restores it after confirmation", async () => {
    const calls = stubApi({
      inline: "current",
      history: [
        { savedAt: "2026-11-01T10:00:00.000Z", bytes: 7, content: "older text", by: "ChatGPT" },
      ],
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ProfileTab vaultEnabled={true} initialPath="System/context.md" />);
    fireEvent.click(await screen.findByRole("button", { name: "View" }));
    expect(screen.getByText("older text")).toBeInTheDocument();
    expect(screen.getByText(/by ChatGPT/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/config/profiles")).toBe(true)
    );
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      action: "restore",
      name: "default",
      index: 0,
    });
    expect(await screen.findByText("Version restored.")).toBeInTheDocument();
  });

  it("does not restore when the confirmation is cancelled", async () => {
    const calls = stubApi({
      inline: "current",
      history: [{ savedAt: "2026-11-01T10:00:00.000Z", bytes: 3, content: "old" }],
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ProfileTab vaultEnabled={true} initialPath="System/context.md" />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore this version" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("Your data (C1.4)", () => {
  it("posts the zip to the export endpoint and renders the report, unknown fields included", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
        return Promise.resolve(
          json({
            ok: true,
            report: {
              profiles: 2,
              skills: { created: 1, updated: 0, failed: 0 },
              notes: { written: 5, skipped: 1, failed: 0 },
              warnings: ["skills/x: bad file"],
              backendSwitched: "kv",
            },
          })
        );
      })
    );
    render(<YourDataSection />);
    expect(screen.getByRole("link", { name: "Export everything (.zip)" })).toHaveAttribute(
      "href",
      "/api/config/export"
    );
    const file = new File([new Uint8Array([80, 75, 3, 4])], "backup.zip", {
      type: "application/zip",
    });
    fireEvent.change(screen.getByLabelText("Import a backup (.zip)"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByLabelText("Overwrite existing notes"));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("Import finished")).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ url: "/api/config/export?overwriteNotes=1", method: "POST" });
    expect(calls[0]!.body).toBe(file);
    const report = screen.getByTestId("import-report");
    expect(report).toHaveTextContent("5 saved, 1 skipped (already there), 0 failed");
    expect(report).toHaveTextContent("skills/x: bad file");
    // A field the UI does not know is still shown.
    expect(report).toHaveTextContent("Backend switched");
    expect(report).toHaveTextContent("kv");
  });

  it("shows the server's message when the import fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(json({ error: "import_failed", message: "Not a Kebab House export" }, 400))
      )
    );
    render(<YourDataSection />);
    fireEvent.change(screen.getByLabelText("Import a backup (.zip)"), {
      target: { files: [new File(["x"], "x.zip")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("Not a Kebab House export")).toBeInTheDocument();
  });

  it("ImportReportView renders an empty warnings list as 'none'", () => {
    render(<ImportReportView report={{ warnings: [] }} />);
    expect(screen.getByTestId("import-report")).toHaveTextContent("Warningsnone");
  });
});
