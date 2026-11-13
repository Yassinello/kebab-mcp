/**
 * @vitest-environment jsdom
 */
import "./setup";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProfilesField } from "../../app/config/tabs/settings/profiles-field";

/** Kebab House phase 0 (CTX-06) — profiles per hat in Settings. */
describe("ProfilesField", () => {
  let profiles: { name: string; mode: "inline"; bytes: number; updatedAt: string | null }[];
  const calls: { url: string; init?: RequestInit }[] = [];

  beforeEach(() => {
    profiles = [
      { name: "default", mode: "inline", bytes: 10, updatedAt: null },
      { name: "work", mode: "inline", bytes: 2048, updatedAt: null },
    ];
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init ? { init } : {}) });
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { name: string };
          profiles.push({ name: body.name, mode: "inline", bytes: 3, updatedAt: null });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ profiles }), { status: 200 });
      })
    );
  });

  it("lists named profiles but not the default one", async () => {
    render(<ProfilesField />);
    expect(await screen.findByText("work")).toBeTruthy();
    expect(screen.queryByText("default")).toBeNull();
  });

  it("creates a profile with a valid name", async () => {
    render(<ProfilesField />);
    fireEvent.click(await screen.findByText("Add a profile"));
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "perso" } });
    fireEvent.change(screen.getByLabelText("Profile content"), { target: { value: "me" } });
    fireEvent.click(screen.getByText("Save profile"));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
    expect(await screen.findByText("perso")).toBeTruthy();
  });

  it("refuses an invalid name without calling the API", async () => {
    render(<ProfilesField />);
    fireEvent.click(await screen.findByText("Add a profile"));
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Bad Name" } });
    fireEvent.click(screen.getByText("Save profile"));
    expect(await screen.findByText(/lowercase letters/)).toBeTruthy();
    expect(calls.some((c) => c.init?.method === "PUT")).toBe(false);
  });
});
