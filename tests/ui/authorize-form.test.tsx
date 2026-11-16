/**
 * @vitest-environment jsdom
 */
/**
 * Audit 2026-11 (A1 / A3) — OAuth consent form: three access levels in plain
 * words (default "Read + my profile and notes"), renamed developer labels,
 * and a clear redirect target for native apps.
 */
import "../components/setup";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthorizeForm } from "../../app/oauth/authorize/authorize-form";

const base = {
  query: "client_id=kc_x",
  clientName: "Claude",
  clientId: "kc_x",
  clientKind: "dcr",
  redirectTarget: "claude.ai",
  redirectIsApp: false,
  profiles: ["default", "work"],
};

function sentBody(): Record<string, unknown> {
  const call = vi.mocked(globalThis.fetch).mock.calls[0]!;
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

describe("AuthorizeForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ message: "stop here" }),
    } as unknown as Response);
  });

  it("offers three access levels, 'Read + my profile and notes' by default", async () => {
    render(<AuthorizeForm {...base} />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["read", "memory", "full"]);
    expect(radios.find((r) => r.checked)?.value).toBe("memory");
    expect(screen.getByText("Read only")).toBeTruthy();
    expect(screen.getByText("Read + my profile and notes (recommended)")).toBeTruthy();
    expect(screen.getByText("Everything")).toBeTruthy();
    expect(screen.getByText(/Each message still needs your approval/)).toBeTruthy();
    // Renamed labels.
    expect(screen.getByText("Profile this client uses")).toBeTruthy();
    expect(screen.getByText("Skills this client sees (tags, empty = all)")).toBeTruthy();
    expect(screen.queryByText(/my_context/)).toBeNull();

    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ decision: "approve", access: "memory" });
    expect(sentBody()).not.toHaveProperty("writeAllowed");
  });

  it("sends the level the owner picks", async () => {
    render(<AuthorizeForm {...base} />);
    fireEvent.click(screen.getByDisplayValue("read"));
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ access: "read" });
  });

  it("shows the full redirect target of a native app", () => {
    render(
      <AuthorizeForm
        {...base}
        redirectTarget="cursor://anysphere.cursor-mcp/oauth/callback"
        redirectIsApp
      />
    );
    expect(screen.getByText("cursor://anysphere.cursor-mcp/oauth/callback")).toBeTruthy();
    expect(screen.getByText(/this app on your computer/)).toBeTruthy();
  });

  it("starts from the existing device's settings on re-authorization", () => {
    render(
      <AuthorizeForm
        {...base}
        existing={{ label: "Claude perso", profile: "work", skillTags: ["perso"], access: "full" }}
      />
    );
    expect((screen.getByDisplayValue("full") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByDisplayValue("Claude perso")).toBeTruthy();
    expect(screen.getByDisplayValue("perso")).toBeTruthy();
    expect(screen.getByText(/already in your Devices list/)).toBeTruthy();
  });
});
