/**
 * @vitest-environment jsdom
 *
 * Phase 53 — ErrorHeatmap UI test.
 *
 * Hand-rolled SVG heatmap; jsdom renders the raw <rect> nodes so we
 * can assert on their fill attributes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ErrorHeatmap } from "@/../app/config/tabs/health/ErrorHeatmap";

afterEach(() => {
  cleanup();
});

const NOW = 1745_000_000_000; // deterministic; tests don't care about the exact value.
const HOUR_MS = 3600_000;

function connector(id: string, errors: number[], totals: number[]) {
  return {
    connectorId: id,
    hours: Array.from({ length: 24 }, (_, i) => ({
      ts: NOW - i * HOUR_MS,
      errors: errors[i] ?? 0,
      total: totals[i] ?? 0,
    })),
  };
}

describe("ErrorHeatmap", () => {
  it("renders one row per connector", () => {
    const { container } = render(
      <ErrorHeatmap connectors={[connector("google", [5], [10]), connector("notion", [0], [3])]} />
    );
    // 2 connectors x 24 hours = 48 <rect> cells.
    expect(container.querySelectorAll("rect").length).toBeGreaterThanOrEqual(48);
  });

  it("renders an empty-state message when no connectors reported", () => {
    const { getByText } = render(<ErrorHeatmap connectors={[]} />);
    expect(getByText(/No connector activity/i)).toBeTruthy();
  });

  it("paints a non-default fill on cells with errors", () => {
    const { container } = render(<ErrorHeatmap connectors={[connector("google", [5], [10])]} />);
    // Cells with errors > 0 get an hsl() fill in the red scale.
    const rects = Array.from(container.querySelectorAll("rect"));
    const withFill = rects.filter((r) => {
      const fill = r.getAttribute("fill") ?? "";
      return fill.startsWith("hsl(0");
    });
    expect(withFill.length).toBeGreaterThanOrEqual(1);
  });

  it("paints zero-error cells with the gray placeholder fill", () => {
    const { container } = render(<ErrorHeatmap connectors={[connector("notion", [0], [0])]} />);
    const rects = Array.from(container.querySelectorAll("rect"));
    // At least 24 cells for notion all in zero state.
    const gray = rects.filter((r) => (r.getAttribute("fill") ?? "").startsWith("#1f2937"));
    expect(gray.length).toBeGreaterThanOrEqual(24);
  });
});
