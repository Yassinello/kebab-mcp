/**
 * @vitest-environment jsdom
 */
/**
 * Audit 2026-11 (A1) — Devices tab: each device shows its access level and
 * the owner can change it with a small select.
 */
import "../components/setup";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DevicesTab } from "../../app/config/tabs/devices";

const devices = [
  {
    tokenId: "0a1b2c3d",
    label: "Claude",
    createdAt: "2026-11-01T00:00:00Z",
    lastSeenAt: null,
    connectors: null,
    skillTags: null,
    profile: null,
    kind: "oauth",
    access: "memory",
  },
];

describe("DevicesTab access level", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      const body = init?.method === "POST" ? { ok: true } : { devices };
      return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
    });
  });

  it("shows the level and saves a change", async () => {
    render(<DevicesTab />);
    const select = (await screen.findByLabelText("What Claude can do")) as HTMLSelectElement;
    expect(select.value).toBe("memory");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Read only",
      "Read + profile and notes",
      "Everything",
    ]);
    fireEvent.change(select, { target: { value: "read" } });
    await waitFor(() =>
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(
            ([, init]) =>
              init?.method === "POST" &&
              JSON.parse(String(init.body)).action === "set-access" &&
              JSON.parse(String(init.body)).access === "read" &&
              JSON.parse(String(init.body)).tokenId === "0a1b2c3d"
          )
      ).toBe(true)
    );
  });
});
