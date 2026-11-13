/**
 * TRU-01 — annotation derivation from the manifest.
 */
import { describe, it, expect } from "vitest";
import {
  connectorOpenWorldDefault,
  deriveToolTitle,
  toolAnnotations,
  toolTitle,
} from "@/core/tool-annotations";

describe("TRU-01 — deriveToolTitle / toolTitle", () => {
  it.each([
    ["vault_read", "Vault read"],
    ["my_context_update", "My context update"],
    ["gmail_inbox", "Gmail inbox"],
    ["greet", "Greet"],
  ])("%s → %s", (name, title) => {
    expect(deriveToolTitle(name)).toBe(title);
  });

  it("an explicit title wins over the derived one", () => {
    expect(toolTitle({ name: "vault_read", title: "Read a note" })).toBe("Read a note");
    expect(toolTitle({ name: "vault_read", title: "  " })).toBe("Vault read");
  });
});

describe("TRU-01 — toolAnnotations", () => {
  const external = { id: "slack" };
  it("readOnlyHint / destructiveHint mirror `destructive`", () => {
    expect(toolAnnotations({ name: "slack_read", destructive: false }, external)).toEqual({
      title: "Slack read",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(toolAnnotations({ name: "slack_send", destructive: true }, external)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("openWorldHint defaults to false for core connectors and the vault, true otherwise", () => {
    expect(connectorOpenWorldDefault({ id: "skills", core: true })).toBe(false);
    expect(connectorOpenWorldDefault({ id: "context", core: true })).toBe(false);
    expect(connectorOpenWorldDefault({ id: "admin", core: true })).toBe(false);
    expect(connectorOpenWorldDefault({ id: "vault" })).toBe(false);
    expect(connectorOpenWorldDefault({ id: "google" })).toBe(true);
    expect(connectorOpenWorldDefault({ id: "api-connections" })).toBe(true);
    expect(connectorOpenWorldDefault({ id: "custom-tools" })).toBe(true);
    expect(connectorOpenWorldDefault({ id: "webhook" })).toBe(true);
  });

  it("a tool's `openWorld` overrides its connector default", () => {
    expect(
      toolAnnotations({ name: "save_article", destructive: true, openWorld: true }, { id: "vault" })
        .openWorldHint
    ).toBe(true);
    expect(
      toolAnnotations({ name: "x", destructive: false, openWorld: false }, external).openWorldHint
    ).toBe(false);
  });
});
