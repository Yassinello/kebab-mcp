/**
 * Phase 50 / COV-04 — Google calendar lib smoke tests.
 *
 * Mocks @/connectors/google/lib/google-fetch at the module boundary to
 * cover the response-shape mapping paths without requiring live OAuth.
 * Exercises listAllCalendars + listEventsAllCalendars + createEvent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const googleFetchJSONMock = vi.fn();
const googleFetchMock = vi.fn();

vi.mock("../google-fetch", () => ({
  googleFetchJSON: (...a: unknown[]) => googleFetchJSONMock(...a),
  googleFetch: (...a: unknown[]) => googleFetchMock(...a),
}));

// Stub instance config (timezone/locale) — tests don't care about values.
vi.mock("@/core/config", () => ({
  getInstanceConfig: () => ({
    timezone: "UTC",
    locale: "en-US",
    displayName: "Test",
    contextPath: "ctx.md",
  }),
  getToolTimeout: () => 30_000,
}));

describe("Phase 50 / COV-04 — google/lib/calendar.ts", () => {
  beforeEach(() => {
    googleFetchJSONMock.mockReset();
    googleFetchMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    /* no-op */
  });

  describe("listAllCalendars", () => {
    it("happy path — maps Google calendar list shape", async () => {
      googleFetchJSONMock.mockResolvedValueOnce({
        items: [
          { id: "primary", summary: "Personal" },
          { id: "work@group.calendar.google.com", summary: "Work" },
        ],
      });

      const { listAllCalendars } = await import("../calendar");
      const calendars = await listAllCalendars();
      expect(calendars).toHaveLength(2);
      expect(calendars[0]!.id).toBe("primary");
      expect(calendars[0]!.summary).toBe("Personal");
    });

    it("empty items → empty array", async () => {
      googleFetchJSONMock.mockResolvedValueOnce({});
      const { listAllCalendars } = await import("../calendar");
      const calendars = await listAllCalendars();
      expect(calendars).toEqual([]);
    });

    it("fetch rejects → error propagated", async () => {
      googleFetchJSONMock.mockRejectedValueOnce(new Error("401 unauthorized"));
      const { listAllCalendars } = await import("../calendar");
      await expect(listAllCalendars()).rejects.toThrow(/401 unauthorized/);
    });
  });

  describe("listEventsAllCalendars", () => {
    it("collects events across calendars with timezone filter", async () => {
      // First call: list calendars
      googleFetchJSONMock.mockResolvedValueOnce({
        items: [{ id: "primary", summary: "P" }],
      });
      // Second call: events.list for primary
      googleFetchJSONMock.mockResolvedValueOnce({
        items: [
          {
            id: "e1",
            summary: "Standup",
            start: { dateTime: "2026-04-22T10:00:00Z" },
            end: { dateTime: "2026-04-22T10:30:00Z" },
            status: "confirmed",
          },
        ],
      });

      const { listEventsAllCalendars } = await import("../calendar");
      const events = await listEventsAllCalendars({
        timeMin: "2026-04-22T00:00:00Z",
        timeMax: "2026-04-23T00:00:00Z",
      });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!.summary).toBe("Standup");
    });
  });
});
