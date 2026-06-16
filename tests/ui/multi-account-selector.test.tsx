/**
 * @vitest-environment jsdom
 *
 * Phase 75 (MAUI-01..03): MultiAccountSelector component test.
 *
 * Verifies the connector-account UI talks to /api/config/accounts (the
 * phase-73 store routes), NOT /api/config/env:
 *   - mount-load lists connected accounts + marks the pinned default,
 *   - the add-account form POSTs tokens and refreshes on success,
 *   - a failing add (testConnection rejected server-side) surfaces inline
 *     without clearing the form,
 *   - Remove issues a DELETE and refreshes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MultiAccountSelector } from "@/../app/config/tabs/multi-account-selector";

type Json = Record<string, unknown>;

interface Routes {
  list?: () => Json;
  post?: (body: Json) => Json;
  del?: (body: Json) => Json;
  putDefault?: (body: Json) => Json;
}

function mockFetch(routes: Routes) {
  const calls: { url: string; method: string; body?: Json | undefined }[] = [];
  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : ((input as Request).url ?? String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Json) : undefined;
    calls.push({ url, method, ...(body !== undefined ? { body } : {}) });

    let payload: Json = { ok: true };
    if (url.includes("/api/config/accounts/default")) {
      payload = routes.putDefault?.(body ?? {}) ?? { ok: true };
    } else if (url.includes("/api/config/accounts")) {
      if (method === "GET") payload = routes.list?.() ?? { ok: true, accounts: [] };
      else if (method === "POST") payload = routes.post?.(body ?? {}) ?? { ok: true };
      else if (method === "DELETE") payload = routes.del?.(body ?? {}) ?? { ok: true };
    }
    return Promise.resolve({
      status: 200,
      ok: true,
      json: () => Promise.resolve(payload),
    } as Response);
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup()); // unmount between tests so duplicate buttons don't leak

describe("MultiAccountSelector", () => {
  it("lists connected accounts and marks the pinned default", async () => {
    mockFetch({
      list: () => ({
        ok: true,
        accounts: [
          { slug: "acme", name: "Acme" },
          { slug: "globex", name: "Globex" },
        ],
        default: "globex",
      }),
    });

    render(<MultiAccountSelector connector="slack" />);

    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    expect(screen.getByText("Globex")).toBeTruthy();
    // The pinned account shows the "Default" badge.
    expect(screen.getByText("Default")).toBeTruthy();
    // Two remove buttons (one per account).
    expect(screen.getAllByText("Remove")).toHaveLength(2);
  });

  it("hits /api/config/accounts on mount, never /api/config/env", async () => {
    const calls = mockFetch({ list: () => ({ ok: true, accounts: [] }) });
    render(<MultiAccountSelector connector="notion" />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]!.url).toContain("/api/config/accounts?connector=notion");
    expect(calls.some((c) => c.url.includes("/api/config/env"))).toBe(false);
  });

  it("POSTs tokens on add and refreshes the list on success", async () => {
    let added = false;
    const calls = mockFetch({
      list: () =>
        added
          ? { ok: true, accounts: [{ slug: "acme", name: "Acme" }] }
          : { ok: true, accounts: [] },
      post: () => {
        added = true;
        return { ok: true, account: { slug: "acme", name: "Acme" } };
      },
    });

    render(<MultiAccountSelector connector="slack" />);
    await waitFor(() => expect(screen.getByText("Add account")).toBeTruthy());

    const botInput = document.querySelector('input[placeholder="xoxb-…"]') as HTMLInputElement;
    fireEvent.change(botInput, { target: { value: "xoxb-good" } });
    fireEvent.click(screen.getByText("Add account"));

    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ connector: "slack", tokens: { SLACK_BOT_TOKEN: "xoxb-good" } });
  });

  it("surfaces a failing add inline without clearing the form", async () => {
    mockFetch({
      list: () => ({ ok: true, accounts: [] }),
      post: () => ({ ok: false, error: "invalid_auth" }),
    });

    render(<MultiAccountSelector connector="notion" />);
    await waitFor(() => expect(screen.getByText("Add account")).toBeTruthy());

    const keyInput = document.querySelector(
      'input[placeholder="secret_… or ntn_…"]'
    ) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "secret_bad" } });
    fireEvent.click(screen.getByText("Add account"));

    await waitFor(() => expect(screen.getByText("invalid_auth")).toBeTruthy());
    // Form value preserved so the operator can fix it.
    expect(keyInput.value).toBe("secret_bad");
  });

  it("issues a DELETE and refreshes when Remove is clicked", async () => {
    let removed = false;
    const calls = mockFetch({
      list: () =>
        removed
          ? { ok: true, accounts: [] }
          : { ok: true, accounts: [{ slug: "acme", name: "Acme" }] },
      del: () => {
        removed = true;
        return { ok: true };
      },
    });

    render(<MultiAccountSelector connector="slack" />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    fireEvent.click(screen.getByText("Remove"));

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.body).toEqual({ connector: "slack", slug: "acme" });
  });

  // ── Phase 76: first-account UX + onAccountsChanged ──────────────────
  it("shows the first-account prompt + opens the form when zero accounts", async () => {
    mockFetch({ list: () => ({ ok: true, accounts: [] }) });
    render(<MultiAccountSelector connector="slack" />);
    // Dynamic summary label for the empty state.
    await waitFor(() => expect(screen.getByText("Connect your first Slack account")).toBeTruthy());
    // The add-form is open by default (the bot-token input is reachable
    // without expanding a collapsed <details>).
    const botInput = document.querySelector('input[placeholder="xoxb-…"]') as HTMLInputElement;
    expect(botInput).toBeTruthy();
  });

  it("renders the where-to-find-it hint pointing at OAuth & Permissions (not Basic Information)", async () => {
    mockFetch({ list: () => ({ ok: true, accounts: [] }) });
    render(<MultiAccountSelector connector="slack" />);
    await waitFor(() => expect(screen.getByText("Connect your first Slack account")).toBeTruthy());
    // The hint must steer the user to OAuth & Permissions and warn off the
    // Basic Information page (the reported confusion). The hint renders as
    // before + <a> + after, so assert against the link + its parent's text.
    const link = screen.getByText("OAuth & Permissions").closest("a");
    expect(link?.getAttribute("href")).toBe("https://api.slack.com/apps");
    expect(link?.parentElement?.textContent).toMatch(/NOT on the Basic Information page/);
  });

  it("fires onAccountsChanged after a successful add", async () => {
    let added = false;
    mockFetch({
      list: () =>
        added
          ? { ok: true, accounts: [{ slug: "acme", name: "Acme" }] }
          : { ok: true, accounts: [] },
      post: () => {
        added = true;
        return { ok: true, account: { slug: "acme", name: "Acme" } };
      },
    });
    const onAccountsChanged = vi.fn();
    render(<MultiAccountSelector connector="slack" onAccountsChanged={onAccountsChanged} />);
    await waitFor(() => expect(screen.getByText("Add account")).toBeTruthy());

    const botInput = document.querySelector('input[placeholder="xoxb-…"]') as HTMLInputElement;
    fireEvent.change(botInput, { target: { value: "xoxb-good" } });
    fireEvent.click(screen.getByText("Add account"));

    await waitFor(() => expect(onAccountsChanged).toHaveBeenCalledTimes(1));
  });
});
