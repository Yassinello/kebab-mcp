import { describe, it, expect } from "vitest";
import { parseEnvFile, serializeEnv } from "./env-store";

describe("parseEnvFile", () => {
  it("parses simple KEY=value pairs", () => {
    const { vars } = parseEnvFile("FOO=bar\nBAZ=qux\n");
    expect(vars).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips double-quoted values", () => {
    const { vars } = parseEnvFile(`FOO="hello world"\n`);
    expect(vars.FOO).toBe("hello world");
  });

  it("strips single-quoted values", () => {
    const { vars } = parseEnvFile(`FOO='hello'\n`);
    expect(vars.FOO).toBe("hello");
  });

  it("ignores comments and blank lines", () => {
    const { vars } = parseEnvFile("# a comment\n\nFOO=bar\n# another\nBAZ=qux\n");
    expect(vars).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("returns rawLines preserving original order", () => {
    const content = "# header\nFOO=1\nBAR=2\n";
    const { rawLines } = parseEnvFile(content);
    expect(rawLines).toEqual(["# header", "FOO=1", "BAR=2", ""]);
  });

  it("handles CRLF line endings", () => {
    const { vars } = parseEnvFile("FOO=bar\r\nBAZ=qux\r\n");
    expect(vars).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores lines without KEY=VAL shape", () => {
    const { vars } = parseEnvFile("not a var\nFOO=bar\n");
    expect(vars).toEqual({ FOO: "bar" });
  });
});

describe("serializeEnv", () => {
  it("updates an existing var in place", () => {
    const { rawLines } = parseEnvFile("FOO=old\nBAR=keep\n");
    const out = serializeEnv(rawLines, { FOO: "new" });
    expect(out).toContain("FOO=new");
    expect(out).toContain("BAR=keep");
    expect(out).not.toContain("FOO=old");
  });

  it("appends a new var at the end", () => {
    const { rawLines } = parseEnvFile("FOO=bar\n");
    const out = serializeEnv(rawLines, { NEW: "value" });
    const idx = out.indexOf("FOO=bar");
    const newIdx = out.indexOf("NEW=value");
    expect(newIdx).toBeGreaterThan(idx);
  });

  it("preserves comments across updates", () => {
    const { rawLines } = parseEnvFile("# important comment\nFOO=old\n");
    const out = serializeEnv(rawLines, { FOO: "new" });
    expect(out).toContain("# important comment");
    expect(out).toContain("FOO=new");
  });

  it("preserves blank lines", () => {
    const { rawLines } = parseEnvFile("FOO=bar\n\nBAZ=qux\n");
    const out = serializeEnv(rawLines, { FOO: "updated" });
    expect(out).toMatch(/FOO=updated\n\nBAZ=qux/);
  });

  it("roundtrip: parse → serialize → parse yields same vars", () => {
    const original = "# header\nFOO=bar\nBAZ=qux\n";
    const parsed = parseEnvFile(original);
    const rewritten = serializeEnv(parsed.rawLines, {});
    const reparsed = parseEnvFile(rewritten);
    expect(reparsed.vars).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ensures trailing newline", () => {
    const { rawLines } = parseEnvFile("FOO=bar");
    const out = serializeEnv(rawLines, {});
    expect(out.endsWith("\n")).toBe(true);
  });

  it("adds both new and updates existing in one call", () => {
    const { rawLines } = parseEnvFile("OLD=1\n");
    const out = serializeEnv(rawLines, { OLD: "2", NEW: "3" });
    expect(out).toContain("OLD=2");
    expect(out).toContain("NEW=3");
  });
});
