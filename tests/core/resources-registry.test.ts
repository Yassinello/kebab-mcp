/**
 * Phase 50 / MCP-01 — resources-registry unit tests.
 *
 * Uses the `__testMockServer()` helper to capture the request handlers
 * registerResources() wires up, then exercises them directly without
 * spinning up the real MCP transport.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerResources,
  __testMockServer,
  type ResourceProvider,
  type ResourceSpec,
  type ResourceContent,
} from "@/core/resources";

function makeProvider(scheme: string, resources: ResourceSpec[]): ResourceProvider {
  return {
    scheme,
    list: async () => resources,
    read: async (uri: string): Promise<ResourceContent> => ({
      uri,
      mimeType: "text/plain",
      text: `body of ${uri}`,
    }),
  };
}

describe("Phase 50 / MCP-01 — registerResources", () => {
  let mockServer: ReturnType<typeof __testMockServer>;

  beforeEach(() => {
    mockServer = __testMockServer();
  });

  it("no providers → zero setRequestHandler calls (no overhead)", () => {
    registerResources({ server: mockServer.server }, []);
    expect(mockServer.handlers.size).toBe(0);
  });

  it("one provider — setRequestHandler called exactly twice (list + read)", () => {
    const p = makeProvider("demo", [{ uri: "demo://x", name: "x", mimeType: "text/plain" }]);
    registerResources({ server: mockServer.server }, [p]);
    expect(mockServer.handlers.size).toBe(2);
  });

  it("declares the `resources` capability before wiring handlers (SDK refuses otherwise)", () => {
    const calls: Array<Record<string, unknown>> = [];
    const server = {
      ...mockServer.server,
      registerCapabilities: (caps: Record<string, unknown>) => calls.push(caps),
    };
    const p = makeProvider("demo", [{ uri: "demo://x", name: "x", mimeType: "text/plain" }]);
    registerResources({ server }, [p]);
    expect(calls).toEqual([{ resources: {} }]);
  });

  it("list handler — concatenates every provider's list() output", async () => {
    const a = makeProvider("a", [
      { uri: "a://1", name: "A1", mimeType: "text/plain" },
      { uri: "a://2", name: "A2", mimeType: "text/plain" },
    ]);
    const b = makeProvider("b", [{ uri: "b://1", name: "B1", mimeType: "text/plain" }]);

    registerResources({ server: mockServer.server }, [a, b]);
    const handlers = [...mockServer.handlers.values()];
    // First registered handler is list (schema order from registerResources).
    const listHandler = handlers[0]!;
    const result = (await listHandler({})) as { resources: ResourceSpec[] };
    expect(result.resources).toHaveLength(3);
    expect(result.resources.map((r) => r.uri)).toEqual(["a://1", "a://2", "b://1"]);
  });

  it("read handler — dispatches by URI scheme to the matching provider", async () => {
    const a = makeProvider("a", []);
    const b = makeProvider("b", []);
    const aRead = vi.fn(async (uri: string) => ({
      uri,
      mimeType: "text/plain",
      text: "a-body",
    }));
    const bRead = vi.fn(async (uri: string) => ({
      uri,
      mimeType: "text/plain",
      text: "b-body",
    }));
    a.read = aRead;
    b.read = bRead;

    registerResources({ server: mockServer.server }, [a, b]);
    const handlers = [...mockServer.handlers.values()];
    const readHandler = handlers[1]!;

    const result = (await readHandler({ params: { uri: "b://foo" } })) as {
      contents: ResourceContent[];
    };
    expect(result.contents[0]!.text).toBe("b-body");
    expect(aRead).not.toHaveBeenCalled();
    expect(bRead).toHaveBeenCalledWith("b://foo");
  });

  it("read handler — unknown scheme → ResourceDispatchError", async () => {
    const a = makeProvider("a", []);
    registerResources({ server: mockServer.server }, [a]);
    const handlers = [...mockServer.handlers.values()];
    const readHandler = handlers[1]!;

    await expect(readHandler({ params: { uri: "unknown://x" } })).rejects.toThrow(
      /unknown scheme "unknown"/
    );
  });

  it("read handler — missing uri param → invalid_request error", async () => {
    const a = makeProvider("a", []);
    registerResources({ server: mockServer.server }, [a]);
    const handlers = [...mockServer.handlers.values()];
    const readHandler = handlers[1]!;

    await expect(readHandler({ params: {} })).rejects.toThrow(/missing 'uri'/);
  });

  it("read handler — malformed URI (no ://) → invalid_uri error", async () => {
    const a = makeProvider("a", []);
    registerResources({ server: mockServer.server }, [a]);
    const handlers = [...mockServer.handlers.values()];
    const readHandler = handlers[1]!;

    await expect(readHandler({ params: { uri: "not-a-uri" } })).rejects.toThrow(/malformed URI/);
  });

  it("duplicate scheme — first provider wins, second ignored with warning", async () => {
    const a1 = makeProvider("dup", [{ uri: "dup://first", name: "F", mimeType: "text/plain" }]);
    const a2 = makeProvider("dup", [{ uri: "dup://second", name: "S", mimeType: "text/plain" }]);
    a1.read = vi.fn(async (uri) => ({ uri, mimeType: "text/plain", text: "first" }));
    a2.read = vi.fn(async (uri) => ({ uri, mimeType: "text/plain", text: "second" }));

    registerResources({ server: mockServer.server }, [a1, a2]);
    const handlers = [...mockServer.handlers.values()];
    const readHandler = handlers[1]!;

    const result = (await readHandler({ params: { uri: "dup://any" } })) as {
      contents: ResourceContent[];
    };
    expect(result.contents[0]!.text).toBe("first"); // first provider wins
  });

  it("list handler — partial failure: one provider throws, others still return", async () => {
    const a = makeProvider("a", [{ uri: "a://1", name: "A1", mimeType: "text/plain" }]);
    const broken = makeProvider("broken", []);
    broken.list = vi.fn(async () => {
      throw new Error("provider broke");
    });

    registerResources({ server: mockServer.server }, [a, broken]);
    const handlers = [...mockServer.handlers.values()];
    const listHandler = handlers[0]!;

    const result = (await listHandler({})) as { resources: ResourceSpec[] };
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.uri).toBe("a://1");
  });

  it("server without setRequestHandler — silent skip with warning", () => {
    // Not an MCP server — no setRequestHandler method.
    const fakeServer = { something: "else" };
    const p = makeProvider("x", []);
    expect(() => registerResources(fakeServer, [p])).not.toThrow();
  });
});
