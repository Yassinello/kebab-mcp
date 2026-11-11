import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { fetchRemote } from "./remote-fetcher";

// Hermetic: fetchRemote's SSRF guard (isPublicUrl with resolveDns) does a
// real DNS lookup of example.com, which fails offline / in sandboxes and
// surfaces as "Blocked or unreachable URL". Resolve to a fixed public IP.
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async () => [{ address: "93.184.215.14", family: 4 }]);
  return { lookup, default: { lookup } };
});

const SECRET = "test-hmac-secret-32-bytes-aaaaaaaa"; // >= 32 chars (MIN_HMAC_SECRET_LEN)
const PAYLOAD = "# Skill\nHello world";
const URL = "https://example.com/skill.md";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function mockFetchResponse(body: string, headers: Record<string, string>): Response {
  return new Response(body, { status: 200, headers });
}

describe("remote-fetcher SEC-A-01 HMAC signature verification", () => {
  const origSecret = process.env.KEBAB_SKILLS_HMAC_SECRET;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (origSecret === undefined) delete process.env.KEBAB_SKILLS_HMAC_SECRET;
    else process.env.KEBAB_SKILLS_HMAC_SECRET = origSecret;
  });

  it("accepts response when HMAC secret is unset (legacy behavior preserved)", async () => {
    delete process.env.KEBAB_SKILLS_HMAC_SECRET;
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(PAYLOAD, {}));
    const result = await fetchRemote(URL);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(PAYLOAD);
  });

  it("accepts response with valid signature", async () => {
    process.env.KEBAB_SKILLS_HMAC_SECRET = SECRET;
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(PAYLOAD, { "x-skill-signature": sign(PAYLOAD, SECRET) })
    );
    const result = await fetchRemote(URL);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(PAYLOAD);
  });

  it("rejects response with missing signature header when secret is set", async () => {
    process.env.KEBAB_SKILLS_HMAC_SECRET = SECRET;
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(PAYLOAD, {}));
    const result = await fetchRemote(URL);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it("rejects response with mismatched signature", async () => {
    process.env.KEBAB_SKILLS_HMAC_SECRET = SECRET;
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(PAYLOAD, { "x-skill-signature": sign(PAYLOAD, "wrong-secret") })
    );
    const result = await fetchRemote(URL);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it("rejects response when body was tampered after signing", async () => {
    process.env.KEBAB_SKILLS_HMAC_SECRET = SECRET;
    const tampered = PAYLOAD + "\nMALICIOUS";
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(tampered, { "x-skill-signature": sign(PAYLOAD, SECRET) })
    );
    const result = await fetchRemote(URL);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it("refuses to operate with a too-short HMAC secret (< 32 chars)", async () => {
    process.env.KEBAB_SKILLS_HMAC_SECRET = "short";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(PAYLOAD, { "x-skill-signature": sign(PAYLOAD, "short") })
    );
    const result = await fetchRemote(URL);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/secret too short/i);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("KEBAB_SKILLS_HMAC_SECRET"));
    errSpy.mockRestore();
  });
});
