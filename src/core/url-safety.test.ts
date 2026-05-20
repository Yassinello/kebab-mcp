import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Module under test — imported lazily inside tests so we can vi.mock("node:dns/promises").
// Note: async vi.mock factory uses hoisting; we use vi.doMock per-test for DNS.

describe("url-safety: isPublicUrlSync (sync, no DNS)", () => {
  let isPublicUrlSync: typeof import("./url-safety").isPublicUrlSync;

  beforeEach(async () => {
    vi.resetModules();
    ({ isPublicUrlSync } = await import("./url-safety"));
  });

  describe("bad scheme", () => {
    it("rejects ftp://", () => {
      const r = isPublicUrlSync("ftp://example.com/");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("bad_scheme");
    });
    it("rejects javascript:", () => {
      const r = isPublicUrlSync("javascript:alert(1)");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("bad_scheme");
    });
    it("rejects file:///etc/passwd", () => {
      const r = isPublicUrlSync("file:///etc/passwd");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("bad_scheme");
    });
  });

  describe("invalid URL", () => {
    it("rejects 'not a url'", () => {
      const r = isPublicUrlSync("not a url");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_url");
    });
    it("rejects empty string", () => {
      const r = isPublicUrlSync("");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_url");
    });
  });

  describe("loopback", () => {
    it.each([
      ["http://localhost/", "loopback"],
      ["http://127.0.0.1/", "loopback"],
      ["http://127.0.0.5/", "loopback"],
      ["http://0.0.0.0/", "loopback"],
      ["http://[::1]/", "loopback"],
    ])("rejects %s", (url, code) => {
      const r = isPublicUrlSync(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(code);
    });
  });

  describe("RFC1918 private IP literals", () => {
    it.each([
      "http://10.0.0.1/",
      "http://10.255.255.255/",
      "http://192.168.1.1/",
      "http://172.16.5.5/",
      "http://172.31.0.1/",
    ])("rejects %s as private_ip", (url) => {
      const r = isPublicUrlSync(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("private_ip");
    });

    it("allows 172.32.x.x (outside 16-31 range)", () => {
      const r = isPublicUrlSync("http://172.32.0.1/");
      expect(r.ok).toBe(true);
    });

    it("allows 172.15.x.x (outside 16-31 range)", () => {
      const r = isPublicUrlSync("http://172.15.255.255/");
      expect(r.ok).toBe(true);
    });
  });

  describe("CGNAT 100.64/10", () => {
    it.each(["http://100.64.0.1/", "http://100.100.100.100/", "http://100.127.255.255/"])(
      "rejects %s as cgnat",
      (url) => {
        const r = isPublicUrlSync(url);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("cgnat");
      }
    );

    it("allows 100.128.0.1 (outside CGNAT range)", () => {
      const r = isPublicUrlSync("http://100.128.0.1/");
      expect(r.ok).toBe(true);
    });

    it("allows 100.63.255.255 (outside CGNAT range)", () => {
      const r = isPublicUrlSync("http://100.63.255.255/");
      expect(r.ok).toBe(true);
    });
  });

  describe("cloud metadata", () => {
    it.each(["http://169.254.169.254/", "http://metadata.google.internal/", "http://metadata/"])(
      "rejects %s as cloud_metadata",
      (url) => {
        const r = isPublicUrlSync(url);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("cloud_metadata");
      }
    );
  });

  describe("link-local 169.254/16 (non-cloud-metadata)", () => {
    it("rejects 169.254.0.1 as link_local", () => {
      const r = isPublicUrlSync("http://169.254.0.1/");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("link_local");
    });
  });

  describe("IPv6 private ranges", () => {
    it.each([
      ["http://[fd00::1]/", "private_ip"],
      ["http://[fc00::1]/", "private_ip"],
      ["http://[fe80::1]/", "link_local"],
      ["http://[fe90::1]/", "link_local"],
      ["http://[fea0::1]/", "link_local"],
      ["http://[feb0::1]/", "link_local"],
    ])("rejects %s", (url, code) => {
      const r = isPublicUrlSync(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(code);
    });
  });

  describe("IPv4-mapped IPv6", () => {
    it("rejects [::ffff:10.0.0.1] as private_ip", () => {
      const r = isPublicUrlSync("http://[::ffff:10.0.0.1]/");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("private_ip");
    });

    it("rejects [::ffff:127.0.0.1] as loopback", () => {
      const r = isPublicUrlSync("http://[::ffff:127.0.0.1]/");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("loopback");
    });
  });

  describe("0.0.0.0/8", () => {
    it("rejects 0.0.0.1 as loopback", () => {
      // 0.0.0.0/8 falls under our loopback category (0.x is unroutable).
      const r = isPublicUrlSync("http://0.0.0.1/");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("loopback");
    });
  });

  describe("public URLs", () => {
    it.each([
      "https://example.com/",
      "https://api.github.com/repos/foo/bar",
      "http://93.184.216.34/", // example.com IP
      "https://8.8.8.8/", // Google DNS
    ])("allows %s", (url) => {
      const r = isPublicUrlSync(url);
      expect(r.ok).toBe(true);
    });
  });

  describe("opts overrides", () => {
    it("allowLoopback lets localhost through", () => {
      const r = isPublicUrlSync("http://localhost/", { allowLoopback: true });
      expect(r.ok).toBe(true);
    });

    it("allowCloudMetadata lets 169.254.169.254 through", () => {
      const r = isPublicUrlSync("http://169.254.169.254/", { allowCloudMetadata: true });
      expect(r.ok).toBe(true);
    });

    it("allowPrivateNetwork lets 10.0.0.1 through", () => {
      const r = isPublicUrlSync("http://10.0.0.1/", { allowPrivateNetwork: true });
      expect(r.ok).toBe(true);
    });

    it("allowPrivateNetwork lets CGNAT 100.64.0.1 through", () => {
      const r = isPublicUrlSync("http://100.64.0.1/", { allowPrivateNetwork: true });
      expect(r.ok).toBe(true);
    });

    it("allowPrivateNetwork does NOT let cloud metadata through", () => {
      const r = isPublicUrlSync("http://169.254.169.254/", { allowPrivateNetwork: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("cloud_metadata");
    });
  });

  describe("bracket stripping", () => {
    it("strips brackets for IPv6 hostnames", () => {
      const r = isPublicUrlSync("http://[::1]/");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("loopback");
    });
  });
});

describe("url-safety: isPublicUrl (async, with DNS option)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:dns/promises");
  });

  it("without resolveDns, public-looking hostname is accepted", async () => {
    vi.resetModules();
    const { isPublicUrl } = await import("./url-safety");
    const r = await isPublicUrl("https://example.com/");
    expect(r.ok).toBe(true);
  });

  it("with resolveDns, hostname resolving to private IP is rejected", async () => {
    vi.resetModules();
    vi.doMock("node:dns/promises", () => ({
      lookup: vi.fn().mockResolvedValue([{ address: "10.0.0.5", family: 4 }]),
    }));
    const { isPublicUrl } = await import("./url-safety");
    const r = await isPublicUrl("https://sneaky.example.com/", { resolveDns: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("dns_resolved_private");
  });

  it("with resolveDns, hostname resolving to public IP is accepted", async () => {
    vi.resetModules();
    vi.doMock("node:dns/promises", () => ({
      lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
    }));
    const { isPublicUrl } = await import("./url-safety");
    const r = await isPublicUrl("https://example.com/", { resolveDns: true });
    expect(r.ok).toBe(true);
  });

  it("with resolveDns, IPv4-mapped IPv6 record is rejected", async () => {
    vi.resetModules();
    vi.doMock("node:dns/promises", () => ({
      lookup: vi.fn().mockResolvedValue([{ address: "::ffff:10.0.0.5", family: 6 }]),
    }));
    const { isPublicUrl } = await import("./url-safety");
    const r = await isPublicUrl("https://sneaky2.example.com/", { resolveDns: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("dns_resolved_private");
  });

  it("with resolveDns, DNS lookup failure is rejected (fail-closed)", async () => {
    vi.resetModules();
    vi.doMock("node:dns/promises", () => ({
      lookup: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })),
    }));
    const { isPublicUrl } = await import("./url-safety");
    const r = await isPublicUrl("https://nonexistent.invalid/", { resolveDns: true });
    expect(r.ok).toBe(false);
  });

  it("without resolveDns, literal private IP is still rejected (sync logic applies)", async () => {
    vi.resetModules();
    const { isPublicUrl } = await import("./url-safety");
    const r = await isPublicUrl("http://10.0.0.1/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("private_ip");
  });
});

describe("url-safety: migration compatibility — browserbase.validatePublicUrl", () => {
  // MEDIUM SSRF fix: validatePublicUrl is now async + DNS-resolving. The IP
  // literals below are validated synchronously (no DNS), so these stay fast
  // and deterministic; the public case uses a literal IP to avoid a real
  // DNS lookup in CI.
  it("still rejects private IP", async () => {
    vi.resetModules();
    const { validatePublicUrl } = await import("@/connectors/browser/lib/browserbase");
    await expect(validatePublicUrl("http://10.0.0.1/")).rejects.toThrow();
  });

  it("still rejects loopback", async () => {
    vi.resetModules();
    const { validatePublicUrl } = await import("@/connectors/browser/lib/browserbase");
    await expect(validatePublicUrl("http://localhost/")).rejects.toThrow();
  });

  it("still rejects invalid URL", async () => {
    vi.resetModules();
    const { validatePublicUrl } = await import("@/connectors/browser/lib/browserbase");
    await expect(validatePublicUrl("not a url")).rejects.toThrow();
  });

  it("still rejects cloud metadata", async () => {
    vi.resetModules();
    const { validatePublicUrl } = await import("@/connectors/browser/lib/browserbase");
    await expect(validatePublicUrl("http://169.254.169.254/")).rejects.toThrow();
  });

  it("accepts a public IP literal silently", async () => {
    vi.resetModules();
    const { validatePublicUrl } = await import("@/connectors/browser/lib/browserbase");
    await expect(validatePublicUrl("https://93.184.216.34/")).resolves.toBeUndefined();
  });
});
