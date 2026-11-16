/**
 * 2026-11 audit (C1.6): the dashboard's colour tokens (app/globals.css
 * @theme) meet WCAG AA — at least 4.5:1 for normal text — on the
 * backgrounds they are used on.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const css = readFileSync(path.join(__dirname, "../../app/globals.css"), "utf8");

function token(name: string): string {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (!m) throw new Error(`token --color-${name} not found`);
  return m[1]!.toLowerCase();
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** `fg` at `alpha` over `bg` — what Tailwind's `bg-x/10` renders. */
function over(fg: string, bg: string, alpha: number): string {
  const f = rgb(fg);
  const b = rgb(bg);
  return (
    "#" +
    f
      .map((v, i) =>
        Math.round(v * alpha + b[i]! * (1 - alpha))
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  );
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const AA = 4.5;

describe("theme tokens — WCAG AA contrast", () => {
  it("computes the reference ratios correctly", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    // The audit's measurement of the old muted label colour.
    expect(contrast("#9ca3af", "#ffffff")).toBeCloseTo(2.54, 1);
  });

  const white = () => token("bg");
  const pairs: Array<[string, () => string, () => string]> = [
    ["text on white", () => token("text"), white],
    ["text-dim on white", () => token("text-dim"), white],
    ["text-dim on bg-muted", () => token("text-dim"), () => token("bg-muted")],
    ["text-dim on sidebar", () => token("text-dim"), () => token("bg-sidebar")],
    ["text-muted on white", () => token("text-muted"), white],
    ["text-muted on bg-muted", () => token("text-muted"), () => token("bg-muted")],
    ["text-muted on sidebar", () => token("text-muted"), () => token("bg-sidebar")],
    ["accent on white (links, active tab)", () => token("accent"), white],
    [
      "accent on active nav item (accent/10 over sidebar)",
      () => token("accent"),
      () => over(token("accent"), token("bg-sidebar"), 0.1),
    ],
    ["white on accent (primary button)", white, () => token("accent")],
    ["green on white", () => token("green"), white],
    ["green pill (green on green-bg)", () => token("green"), () => token("green-bg")],
    ["orange on white", () => token("orange"), white],
    ["orange pill (orange on orange-bg)", () => token("orange"), () => token("orange-bg")],
    [
      "orange-dark on orange/5 banner",
      () => token("orange-dark"),
      () => over(token("orange"), white(), 0.05),
    ],
    ["red on white", () => token("red"), white],
    ["red pill (red on red-bg)", () => token("red"), () => token("red-bg")],
    ["red on red/5 banner", () => token("red"), () => over(token("red"), white(), 0.05)],
    ["white on red (danger button)", white, () => token("red")],
  ];

  for (const [label, fg, bg] of pairs) {
    it(`${label} ≥ ${AA}:1`, () => {
      expect(contrast(fg(), bg())).toBeGreaterThanOrEqual(AA);
    });
  }
});
