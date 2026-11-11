/** Spec v2 — text matching, attachment decoding, kill switches, webhook R8, caps. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { config } = vi.hoisted(() => ({ config: new Map<string, string>() }));
vi.mock("@/core/config-facade", () => ({
  getConfig: (k: string) => config.get(k),
  getConfigInt: (k: string, d: number) => (config.has(k) ? Number(config.get(k)) : d),
}));

import { normalizeText, queryTerms, matchesAllTerms, digitsOnly, snippet } from "../text-match";
import { decodeAttachments, ATTACHMENT_MAX_BYTES } from "../attachments";
import {
  isWritesDisabled,
  isWhatsappWritesDisabled,
  isChannelWritesDisabled,
} from "../kill-switch";
import { getCaps } from "../rate-limiter";
import { hashMaterial } from "../write-guard";
import { isIgnoredEvent } from "../../webhook/dispatcher";

beforeEach(() => config.clear());

describe("text-match", () => {
  it("normalizes accents, case and spaces", () => {
    expect(normalizeText("  Réunion   BORDERLAND ")).toBe("reunion borderland");
    expect(queryTerms("Élan  vital")).toEqual(["elan", "vital"]);
  });
  it("all terms must match", () => {
    expect(matchesAllTerms("Les vans sur la Playa", ["playa", "vans"])).toBe(true);
    expect(matchesAllTerms("Les vans", ["playa", "vans"])).toBe(false);
    expect(matchesAllTerms(null, ["x"])).toBe(false);
    expect(matchesAllTerms("x", [])).toBe(false);
  });
  it("digitsOnly + snippet", () => {
    expect(digitsOnly("+33 (6) 12-34")).toBe("3361234");
    expect(snippet("short", ["s"])).toBe("short");
    const s = snippet(`${"a".repeat(300)}needle${"b".repeat(300)}`, ["needle"]);
    expect(s.startsWith("…")).toBe(true);
    expect(s).toContain("needle");
  });
});

describe("attachments", () => {
  it("decodes base64", () => {
    const r = decodeAttachments([
      { filename: "a.txt", mimetype: "text/plain", base64: Buffer.from("hey").toString("base64") },
    ]);
    expect(r.ok && r.attachments[0]![1].toString()).toBe("hey");
  });
  it("rejects oversize from the estimate without decoding", () => {
    const r = decodeAttachments([
      {
        filename: "big",
        mimetype: "application/pdf",
        base64: "A".repeat(Math.ceil(((ATTACHMENT_MAX_BYTES + 1024) * 4) / 3)),
      },
    ]);
    expect(r.ok).toBe(false);
  });
  it("undefined → empty", () =>
    expect(decodeAttachments(undefined)).toEqual({ ok: true, attachments: [] }));
});

describe("kill switches", () => {
  it("channel switches are independent", () => {
    config.set("KEBAB_UNIPILE_WHATSAPP_WRITES_DISABLED", "true");
    expect(isWhatsappWritesDisabled()).toBe(true);
    expect(isWritesDisabled()).toBe(false);
    expect(isChannelWritesDisabled("LINKEDIN")).toBe(false);
  });
  it("global switch covers both", () => {
    config.set("KEBAB_UNIPILE_WRITES_DISABLED", "1");
    expect(isWritesDisabled()).toBe(true);
    expect(isChannelWritesDisabled("WHATSAPP")).toBe(true);
  });
  it("only 'true'/'1' are truthy", () => {
    config.set("KEBAB_UNIPILE_WRITES_DISABLED", "yes");
    expect(isWhatsappWritesDisabled()).toBe(false);
  });
});

describe("spec v2 caps", () => {
  it("defaults", () => {
    expect(getCaps("whatsapp_send")).toEqual({ daily: 100, weekly: null });
    expect(getCaps("linkedin_post_engagement")).toEqual({ daily: 40, weekly: null });
    expect(getCaps("linkedin_post")).toEqual({ daily: 3, weekly: null });
    expect(getCaps("linkedin_cancel_invitation")).toEqual({ daily: 30, weekly: null });
  });
  it("env override", () => {
    config.set("KEBAB_UNIPILE_WHATSAPP_DAILY_SEND_CAP", "7");
    expect(getCaps("whatsapp_send").daily).toBe(7);
  });
});

describe("hashMaterial", () => {
  it("is key-order independent and content sensitive", () => {
    expect(hashMaterial("t", { a: 1, b: "x" })).toBe(hashMaterial("t", { b: "x", a: 1 }));
    expect(hashMaterial("t", { a: 1 })).not.toBe(hashMaterial("t", { a: 2 }));
    expect(hashMaterial("t", { a: 1 })).not.toBe(hashMaterial("u", { a: 1 }));
  });
});

describe("webhook R8 — isIgnoredEvent", () => {
  it("drops outbound echoes and WhatsApp inbound messages only", () => {
    expect(isIgnoredEvent({ event: "message_received", is_sender: true })).toBe(true);
    expect(isIgnoredEvent({ event: "message_received", account_type: "WHATSAPP" })).toBe(true);
    expect(isIgnoredEvent({ event: "message_received", account_type: "LINKEDIN" })).toBe(false);
    expect(isIgnoredEvent({ event: "new_relation", account_type: "WHATSAPP" })).toBe(false);
    expect(isIgnoredEvent({ account_status: "OK", account_type: "WHATSAPP" })).toBe(false);
  });
});
