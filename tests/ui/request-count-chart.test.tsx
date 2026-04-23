/**
 * @vitest-environment jsdom
 *
 * Phase 53 — RequestCountChart UI test.
 *
 * Covers the empty-state fallback path + the populated-chart render.
 * Recharts SVG nodes are hard to assert deeply in jsdom (no layout),
 * so we check for the presence of the ResponsiveContainer wrapper
 * class and the empty-state text directly.
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { RequestCountChart } from "@/../app/config/tabs/health/RequestCountChart";

// jsdom has no ResizeObserver — Recharts' ResponsiveContainer requires it.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
});

describe("RequestCountChart", () => {
  it("renders empty-state text when hours is empty", () => {
    render(<RequestCountChart hours={[]} tools={[]} toolFilter="" onToolChange={() => {}} />);
    expect(screen.getByText(/No requests in the last 24h/i)).toBeTruthy();
  });

  it("renders empty-state text when every bucket is zero", () => {
    const hours = Array.from({ length: 24 }, (_, i) => ({
      ts: Date.now() - i * 3600_000,
      count: 0,
    }));
    render(<RequestCountChart hours={hours} tools={[]} toolFilter="" onToolChange={() => {}} />);
    expect(screen.getByText(/No requests in the last 24h/i)).toBeTruthy();
  });

  it("renders chart (no empty-state) when at least one bucket is non-zero", () => {
    const hours = Array.from({ length: 24 }, (_, i) => ({
      ts: Date.now() - i * 3600_000,
      count: i === 0 ? 5 : 0,
    }));
    const { container } = render(
      <RequestCountChart
        hours={hours}
        tools={["gmail.search", "notion.read"]}
        toolFilter=""
        onToolChange={() => {}}
      />
    );
    // No empty-state text, because at least one bucket has count > 0.
    expect(screen.queryByText(/No requests in the last 24h/i)).toBeNull();
    // Tool filter dropdown renders the two choices + "All tools".
    expect(screen.getByRole("combobox")).toBeTruthy();
    // ResponsiveContainer renders a wrapper — width should be set.
    expect(container.querySelector(".recharts-responsive-container")).toBeTruthy();
  });
});
