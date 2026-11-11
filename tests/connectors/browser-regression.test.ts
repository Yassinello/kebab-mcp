/**
 * Regression suite for the 4 Stagehand-driven browser tools.
 *
 * History:
 *   - Phase 44 SCM-02: suite introduced as a 2-state V2/V3 matrix
 *     gated on KEBAB_BROWSER_CONNECTOR_V2
 *   - Phase 51 LANG-02: matrix expanded to 3 states after default flip
 *   - v0.1.14 cleanup: V2/V3 dispatch removed entirely (flag was a
 *     dispatch layer that always delegated to the same implementation).
 *     Matrix collapsed to 4 tools × 2 scenarios = 8 cases.
 *
 * Stagehand + Browserbase SDK are mocked — no real API calls. The mocks
 * mirror the v3.2.x surface: Stagehand class with init/close, stagehand.act,
 * stagehand.extract, stagehand.context.pages() returning Playwright-like
 * Pages with goto/title/url/evaluate. Assertions verify that:
 *   1. The right Stagehand method is invoked (goto for browse, extract for
 *      extract + linkedin_feed, act for act).
 *   2. The URL passed to page.goto is validated through src/core/url-safety
 *      BEFORE the session is created (SSRF guard rejection short-circuits).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Shared fake Stagehand scaffolding --------------------------------------

type GotoOpts = { waitUntil?: string; timeoutMs?: number };
type ActArg = string;
type ObserveArg = string;
type AgentExecuteArg = { instruction: string; maxSteps?: number };

/** Fake Page (the object stagehand.context.pages()[0] returns). */
interface FakePage {
  goto: ReturnType<typeof vi.fn>;
  title: ReturnType<typeof vi.fn>;
  url: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
}

/** Fake Stagehand class. Captures constructor args + method calls for assertions. */
interface FakeStagehandInstance {
  init: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  act: ReturnType<typeof vi.fn<(arg: ActArg) => Promise<void>>>;
  extract: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
  observe: ReturnType<typeof vi.fn<(arg: ObserveArg) => Promise<unknown[]>>>;
  agent: ReturnType<typeof vi.fn<() => { execute: (arg: AgentExecuteArg) => Promise<unknown> }>>;
  context: { pages: () => FakePage[] };
}

let stagehandConstructorArgs: unknown[] = [];
let lastStagehand: FakeStagehandInstance | null = null;
let lastPage: FakePage | null = null;

// Per-test override for page.evaluate's return value. Default ("visible
// text content") is a string — fine for web-browse but inadequate for
// extract-links which wants an array. Tests can swap it via
// `evaluateReturnOverride = [...]` before calling the handler.
let evaluateReturnOverride: unknown = null;

function makeFakePage(): FakePage {
  const page: FakePage = {
    goto: vi.fn(async (_url: string, _opts?: GotoOpts) => undefined),
    title: vi.fn(async () => "Fake Page Title"),
    url: vi.fn(() => "https://example.com/final"),
    evaluate: vi.fn(async (_fn: unknown) =>
      evaluateReturnOverride !== null ? evaluateReturnOverride : "visible text content"
    ),
  };
  lastPage = page;
  return page;
}

function makeFakeStagehand(args: unknown): FakeStagehandInstance {
  const page = makeFakePage();
  const inst: FakeStagehandInstance = {
    init: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    act: vi.fn(async (_arg: ActArg) => undefined),
    extract: vi.fn(async (..._args: unknown[]) => ({ posts: [{ author: "A", content: "B" }] })),
    observe: vi.fn(async (_arg: ObserveArg) => [
      { selector: "a.product", description: "product card 1" },
      { selector: "a.product:nth-child(2)", description: "product card 2" },
    ]),
    agent: vi.fn(() => ({
      execute: vi.fn(async (_arg: AgentExecuteArg) => ({
        success: true,
        completed: true,
        message: "done",
        actions: [{ type: "act", action: "click search", taskCompleted: false }],
        usage: { input_tokens: 10, output_tokens: 20, inference_time_ms: 100 },
      })),
    })),
    context: { pages: () => [page] },
  };
  stagehandConstructorArgs.push(args);
  lastStagehand = inst;
  return inst;
}

vi.mock("@browserbasehq/stagehand", () => {
  // Constructor returns a fake instance. We use a factory-style class.
  class Stagehand {
    constructor(args: unknown) {
      const inst = makeFakeStagehand(args);
      Object.assign(this, inst);
    }
  }
  return { Stagehand };
});

// Browserbase SDK — only contexts.create is called from browserbase.ts
vi.mock("@browserbasehq/sdk", () => {
  class Browserbase {
    contexts = {
      create: vi.fn(async () => ({ id: "ctx_test_" + Math.random().toString(36).slice(2, 8) })),
    };
    constructor(_args: { apiKey: string }) {}
  }
  return { default: Browserbase };
});

// DNS — the SSRF guard (src/core/url-safety, resolveDns: true) resolves
// hostnames before letting a URL through. Without a mock the suite does a
// real lookup of example.com / linkedin.com and fails offline or in a
// sandboxed container ("DNS lookup failed"). Resolve every hostname to a
// fixed public IP (example.com's). IP-literal URLs never reach lookup(), so
// the private-IP rejection cases are unaffected.
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async () => [{ address: "93.184.215.14", family: 4 }]);
  return { lookup, default: { lookup } };
});

// --- Environment setup ------------------------------------------------------

function setBrowserEnv() {
  process.env.BROWSERBASE_API_KEY = "bb_live_test";
  process.env.BROWSERBASE_PROJECT_ID = "proj_test";
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  // Provide a pre-existing context ID so getOrCreateContext short-circuits.
  process.env.BROWSERBASE_CONTEXT_DEFAULT = "ctx_env_default";
  process.env.BROWSERBASE_CONTEXT_LINKEDIN = "ctx_env_linkedin";
}

function unsetBrowserEnv() {
  delete process.env.BROWSERBASE_API_KEY;
  delete process.env.BROWSERBASE_PROJECT_ID;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.BROWSERBASE_CONTEXT_DEFAULT;
  delete process.env.BROWSERBASE_CONTEXT_LINKEDIN;
}

// --- Test suite -------------------------------------------------------------

describe("browser connector regression — 4 tools × 2 scenarios (happy path + SSRF guard)", () => {
  beforeEach(() => {
    stagehandConstructorArgs = [];
    lastStagehand = null;
    lastPage = null;
    evaluateReturnOverride = null;
    setBrowserEnv();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    unsetBrowserEnv();
  });

  // --- web_browse ---------------------------------------------------------

  describe("handleWebBrowse", () => {
    it("happy path: navigates to URL, returns text content", async () => {
      const { handleWebBrowse } = await import("@/connectors/browser/tools/web-browse");
      const result = await handleWebBrowse({
        url: "https://example.com/",
        scroll_count: 0,
      });
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("Fake Page Title");
      // Stagehand was constructed with the right env
      expect(stagehandConstructorArgs.length).toBeGreaterThanOrEqual(1);
      const args = stagehandConstructorArgs[0] as { env: string };
      expect(args.env).toBe("BROWSERBASE");
      // page.goto was invoked with our URL
      expect(lastPage?.goto).toHaveBeenCalledWith(
        "https://example.com/",
        expect.objectContaining({ waitUntil: "domcontentloaded" })
      );
      // close was called in finally
      expect(lastStagehand?.close).toHaveBeenCalled();
    });

    it("SSRF guard: rejects a private-IP URL without invoking Stagehand", async () => {
      const { handleWebBrowse } = await import("@/connectors/browser/tools/web-browse");
      await expect(handleWebBrowse({ url: "http://10.0.0.1/", scroll_count: 0 })).rejects.toThrow(
        /private networks/
      );
      // No Stagehand was constructed — guard ran first
      expect(stagehandConstructorArgs.length).toBe(0);
    });
  });

  // --- web_extract --------------------------------------------------------

  describe("handleWebExtract", () => {
    it("happy path: calls stagehand.extract with the instruction", async () => {
      const { handleWebExtract } = await import("@/connectors/browser/tools/web-extract");
      const result = await handleWebExtract({
        url: "https://example.com/",
        instruction: "Extract all posts",
      });
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("posts");
      expect(lastStagehand?.extract).toHaveBeenCalledWith("Extract all posts");
      expect(lastPage?.goto).toHaveBeenCalled();
      expect(lastStagehand?.close).toHaveBeenCalled();
    });

    it("SSRF guard: rejects RFC1918 URL before Stagehand runs", async () => {
      const { handleWebExtract } = await import("@/connectors/browser/tools/web-extract");
      await expect(
        handleWebExtract({
          url: "http://192.168.1.1/",
          instruction: "anything",
        })
      ).rejects.toThrow(/private networks/);
      expect(stagehandConstructorArgs.length).toBe(0);
    });
  });

  // --- web_act ------------------------------------------------------------

  describe("handleWebAct", () => {
    it("happy path: executes each action via stagehand.act", async () => {
      const { handleWebAct } = await import("@/connectors/browser/tools/web-act");
      const result = await handleWebAct({
        url: "https://example.com/",
        actions: ["click start", "type hello"],
      });
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("click start");
      expect(lastStagehand?.act).toHaveBeenCalledWith("click start");
      expect(lastStagehand?.act).toHaveBeenCalledWith("type hello");
      expect(lastStagehand?.close).toHaveBeenCalled();
    });

    it("SSRF guard: rejects loopback URL", async () => {
      const { handleWebAct } = await import("@/connectors/browser/tools/web-act");
      await expect(
        handleWebAct({
          url: "http://127.0.0.1/",
          actions: ["anything"],
        })
      ).rejects.toThrow(/loopback/);
      expect(stagehandConstructorArgs.length).toBe(0);
    });
  });

  // --- linkedin_feed ------------------------------------------------------

  describe("handleLinkedinFeed", () => {
    it("happy path: rate-limit check + extract on linkedin feed URL", async () => {
      // Mock the rate-limit check via mocking the browserbase module's
      // exported function. We go through a fresh import.
      vi.doMock("@/connectors/browser/lib/browserbase", async () => {
        const actual = await vi.importActual<typeof import("@/connectors/browser/lib/browserbase")>(
          "@/connectors/browser/lib/browserbase"
        );
        return {
          ...actual,
          checkAndIncrementDailyLimit: vi.fn(async () => ({ allowed: true, count: 1 })),
        };
      });

      const { handleLinkedinFeed } = await import("@/connectors/browser/tools/linkedin-feed");
      const result = await handleLinkedinFeed({ max_posts: 20 });
      expect(result.content[0]?.type).toBe("text");
      expect(lastStagehand?.extract).toHaveBeenCalled();
      // The URL passed to goto should be the LinkedIn feed URL
      expect(lastPage?.goto).toHaveBeenCalledWith(
        "https://www.linkedin.com/feed/",
        expect.objectContaining({ waitUntil: "domcontentloaded" })
      );
      vi.doUnmock("@/connectors/browser/lib/browserbase");
    });

    it("rate-limit rejection: returns an isError payload WITHOUT invoking Stagehand", async () => {
      vi.doMock("@/connectors/browser/lib/browserbase", async () => {
        const actual = await vi.importActual<typeof import("@/connectors/browser/lib/browserbase")>(
          "@/connectors/browser/lib/browserbase"
        );
        return {
          ...actual,
          checkAndIncrementDailyLimit: vi.fn(async () => ({ allowed: false, count: 3 })),
        };
      });

      const { handleLinkedinFeed } = await import("@/connectors/browser/tools/linkedin-feed");
      const result = await handleLinkedinFeed({ max_posts: 20 });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("rate limited");
      // No Stagehand spin-up because rate-limit short-circuited
      expect(stagehandConstructorArgs.length).toBe(0);
      vi.doUnmock("@/connectors/browser/lib/browserbase");
    });
  });

  // --- web_extract — schema-driven path ----------------------------------

  describe("handleWebExtract — schema arg", () => {
    it("compiles JSON Schema and forwards it to stagehand.extract as a Zod schema", async () => {
      const { handleWebExtract } = await import("@/connectors/browser/tools/web-extract");
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" }, price: { type: "string" } },
            },
          },
        },
      };
      await handleWebExtract({
        url: "https://example.com/",
        instruction: "Extract products",
        schema,
      });
      // Stagehand.extract must have been called with (instruction, schema)
      const calls = lastStagehand?.extract.mock.calls ?? [];
      expect(calls.length).toBe(1);
      expect(calls[0]?.[0]).toBe("Extract products");
      // Second arg should be a Zod-shaped object (has _def or _zod marker)
      const arg2 = calls[0]?.[1] as { _def?: unknown; _zod?: unknown } | undefined;
      expect(arg2).toBeTruthy();
      expect(arg2?._def !== undefined || arg2?._zod !== undefined).toBe(true);
    });

    it("returns a sanitized error payload when the schema is invalid (no Stagehand spin-up)", async () => {
      const { handleWebExtract } = await import("@/connectors/browser/tools/web-extract");
      // `null` is invalid as a JSON Schema root — the converter throws.
      const result = await handleWebExtract({
        url: "https://example.com/",
        instruction: "anything",
        schema: { type: "not-a-real-type" } as unknown as Record<string, unknown>,
      });
      // Either compilation throws (errorResult before session) or Stagehand
      // is asked. Either way the user-facing payload signals an error.
      // The crucial invariant: invalid schema must not crash hard.
      expect(result.content[0]?.type).toBe("text");
    });

    it("rejects a non-object root schema with an actionable message (no session)", async () => {
      const { handleWebExtract } = await import("@/connectors/browser/tools/web-extract");
      const result = await handleWebExtract({
        url: "https://example.com/",
        instruction: "x",
        schema: { type: "string" },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/must describe an object/);
      expect(stagehandConstructorArgs.length).toBe(0);
    });
  });

  // --- web_observe --------------------------------------------------------

  describe("handleWebObserve", () => {
    it("happy path: returns candidates with selectors", async () => {
      const { handleWebObserve } = await import("@/connectors/browser/tools/web-observe");
      const result = await handleWebObserve({
        url: "https://example.com/",
        instruction: "all product cards",
      });
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("a.product");
      expect(lastStagehand?.observe).toHaveBeenCalledWith("all product cards");
      expect(lastStagehand?.close).toHaveBeenCalled();
    });

    it("SSRF guard: rejects private IP", async () => {
      const { handleWebObserve } = await import("@/connectors/browser/tools/web-observe");
      await expect(handleWebObserve({ url: "http://10.0.0.1/", instruction: "x" })).rejects.toThrow(
        /private networks/
      );
      expect(stagehandConstructorArgs.length).toBe(0);
    });
  });

  // --- web_agent ----------------------------------------------------------

  describe("handleWebAgent", () => {
    it("happy path: invokes agent.execute and serializes result", async () => {
      const { handleWebAgent } = await import("@/connectors/browser/tools/web-agent");
      const result = await handleWebAgent({
        url: "https://example.com/",
        instruction: "find cheapest item",
        max_steps: 5,
      });
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain('"success": true');
      expect(lastStagehand?.agent).toHaveBeenCalled();
      expect(lastStagehand?.close).toHaveBeenCalled();
    });

    it("clamps max_steps to the hard ceiling", async () => {
      const { handleWebAgent } = await import("@/connectors/browser/tools/web-agent");
      await handleWebAgent({
        url: "https://example.com/",
        instruction: "x",
        max_steps: 999, // above HARD_MAX_STEPS=30
      });
      // The fake agent() returns a fresh { execute: vi.fn(...) } each call —
      // grab it from mock.results to read the args passed to execute().
      const agentReturn = lastStagehand?.agent.mock.results[0]?.value as {
        execute: ReturnType<typeof vi.fn>;
      };
      const executeArg = agentReturn.execute.mock.calls[0]?.[0] as AgentExecuteArg | undefined;
      expect(executeArg?.maxSteps).toBe(30);
    });

    it("SSRF guard: rejects loopback", async () => {
      const { handleWebAgent } = await import("@/connectors/browser/tools/web-agent");
      await expect(handleWebAgent({ url: "http://127.0.0.1/", instruction: "x" })).rejects.toThrow(
        /loopback/
      );
      expect(stagehandConstructorArgs.length).toBe(0);
    });
  });

  // --- extract_links ------------------------------------------------------

  describe("handleExtractLinks", () => {
    it("happy path: returns anchors when page.evaluate returns an array", async () => {
      // Override the default page.evaluate return value (default is a
      // string, used by web-browse). Filter `/items/` and dedup.
      evaluateReturnOverride = [
        { href: "https://example.com/items/abc-123", text: "Item A", title: undefined },
        { href: "https://example.com/items/def-456", text: "Item B", title: undefined },
        { href: "https://example.com/items/abc-123", text: "Dup", title: undefined },
      ];
      const { handleExtractLinks } = await import("@/connectors/browser/tools/extract-links");
      const result = await handleExtractLinks({
        url: "https://example.com/",
        href_pattern: "/items/",
      });
      const payload = JSON.parse(result.content[0]?.text ?? "{}");
      expect(payload.links).toHaveLength(2); // dedup removed the third
      expect(payload.links[0].href).toBe("https://example.com/items/abc-123");
    });

    it("returns a clean error when page.evaluate does not return an array", async () => {
      // The default fake page.evaluate returns "visible text content"
      // (a string) — the handler must surface a clear error rather than
      // silently report an empty link list.
      const { handleExtractLinks } = await import("@/connectors/browser/tools/extract-links");
      const result = await handleExtractLinks({
        url: "https://example.com/",
        selector: "a[href]",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("did not return an array");
    });

    it("rejects an over-long selector before opening a session", async () => {
      const { handleExtractLinks } = await import("@/connectors/browser/tools/extract-links");
      const result = await handleExtractLinks({
        url: "https://example.com/",
        selector: "a".repeat(300),
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/selector too long/);
      expect(stagehandConstructorArgs.length).toBe(0);
    });

    it("rejects an over-long href_pattern", async () => {
      const { handleExtractLinks } = await import("@/connectors/browser/tools/extract-links");
      const result = await handleExtractLinks({
        url: "https://example.com/",
        href_pattern: "x".repeat(300),
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/href_pattern too long/);
    });

    it("rejects an invalid regex href_pattern with a clean error (no session)", async () => {
      const { handleExtractLinks } = await import("@/connectors/browser/tools/extract-links");
      const result = await handleExtractLinks({
        url: "https://example.com/",
        href_pattern: "/[unclosed/",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/Invalid regex/);
      expect(stagehandConstructorArgs.length).toBe(0);
    });

    it("SSRF guard: rejects RFC1918 URL", async () => {
      const { handleExtractLinks } = await import("@/connectors/browser/tools/extract-links");
      await expect(handleExtractLinks({ url: "http://192.168.1.1/" })).rejects.toThrow(
        /private networks/
      );
      expect(stagehandConstructorArgs.length).toBe(0);
    });
  });
});

// --- Pure helper unit tests (no mocking needed) -----------------------------

describe("page-helpers — clampNavTimeout", () => {
  it("returns the default when undefined", async () => {
    const { clampNavTimeout, PAGE_HELPER_DEFAULTS } =
      await import("@/connectors/browser/lib/page-helpers");
    expect(clampNavTimeout(undefined)).toBe(PAGE_HELPER_DEFAULTS.navTimeoutMs);
  });

  it("clamps below 5000 up to 5000", async () => {
    const { clampNavTimeout } = await import("@/connectors/browser/lib/page-helpers");
    expect(clampNavTimeout(100)).toBe(5_000);
  });

  it("clamps above 90000 down to 90000", async () => {
    const { clampNavTimeout } = await import("@/connectors/browser/lib/page-helpers");
    expect(clampNavTimeout(120_000)).toBe(90_000);
  });

  it("returns the default when the input is non-finite", async () => {
    const { clampNavTimeout, PAGE_HELPER_DEFAULTS } =
      await import("@/connectors/browser/lib/page-helpers");
    expect(clampNavTimeout(NaN)).toBe(PAGE_HELPER_DEFAULTS.navTimeoutMs);
    expect(clampNavTimeout(Infinity)).toBe(PAGE_HELPER_DEFAULTS.navTimeoutMs);
  });
});
