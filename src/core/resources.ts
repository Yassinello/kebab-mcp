/**
 * Phase 50 / MCP-01 — MCP `resources/*` capability registry.
 *
 * Provides the connector-author-facing interface for exposing readable
 * artifacts (files, notes, records) via the MCP `resources/list` and
 * `resources/read` methods. Pilot in `src/connectors/vault/resources.ts`
 * exposes Obsidian vault markdown files under `vault://<path>` URIs.
 *
 * Resolution: each enabled connector optionally implements
 * `manifest.resources: ResourceProvider`. The transport (app/api/[transport]/
 * route.ts) collects all providers and calls registerResources(server, providers)
 * after tool registration.
 *
 * Dispatch: URIs carry a scheme (e.g., "vault://") which maps 1:1 to the
 * `ResourceProvider.scheme` field. Requests to an unknown scheme return a
 * typed error. This keeps inter-connector resource namespaces clean.
 */

import { toMsg } from "./error-utils";

/** A single listable resource exposed by a connector. */
export interface ResourceSpec {
  /** Opaque URI (e.g., "vault://notes/hello.md"). Unique per resource. */
  uri: string;
  /** Human-readable name, shown in MCP clients. */
  name: string;
  /** Optional description (shown as a tooltip / subtitle). */
  description?: string;
  /** MIME type (e.g., "text/markdown", "application/json"). */
  mimeType: string;
}

/** A single resource's body, returned by read(). */
export interface ResourceContent {
  /** The URI that was read (echoed back). */
  uri: string;
  /** MIME type of the payload. */
  mimeType: string;
  /** UTF-8 text body (use `text` OR `blob`, not both). */
  text?: string;
  /** Base64-encoded binary body (use `blob` OR `text`, not both). */
  blob?: string;
}

/**
 * Connector-level provider for MCP resources. Connectors implement this
 * interface and expose it via `ConnectorManifest.resources`.
 */
export interface ResourceProvider {
  /**
   * URI scheme this provider owns (e.g., "vault"). Used to dispatch
   * read() calls to the correct provider when multiple connectors
   * expose resources simultaneously.
   */
  scheme: string;
  /** Enumerate all resources currently available. */
  list(): Promise<ResourceSpec[]>;
  /** Read a single resource by URI. Throws on unknown/invalid URIs. */
  read(uri: string): Promise<ResourceContent>;
}

/**
 * Unknown-scheme / invalid-URI error thrown when a client asks for a
 * resource the current providers don't own. MCP framework surfaces
 * this as a typed `resources/read` error response.
 */
export class ResourceDispatchError extends Error {
  public readonly code: string;
  constructor(message: string, code = "resource_dispatch_error") {
    super(message);
    this.name = "ResourceDispatchError";
    this.code = code;
  }
}

/**
 * Register resource providers on an `McpServer`. Wires up:
 *  - resources/list → concat of every provider's list() output
 *  - resources/read → dispatches by URI scheme to the matching provider
 *
 * Providers are called in the order they appear in the input array.
 * Their `list()` outputs are interleaved; resources/list preserves order.
 *
 * The `server` parameter is typed loosely as `unknown` to avoid leaking
 * the `mcp-handler` / `@modelcontextprotocol/server` internals into core —
 * consistent with the `registerPrompts` hook. Concrete shape: the SDK v2
 * `McpServer` exposes its low-level `Server` as `server.server`, whose
 * `setRequestHandler(method, handler)` takes the spec method string
 * (`"resources/list"`, `"resources/read"`) and parses the request with the
 * spec schema for the era being served (2025 or 2026-07-28).
 */
export function registerResources(server: unknown, providers: ResourceProvider[]): void {
  if (providers.length === 0) return;

  // Build the scheme → provider map once. O(1) dispatch per read.
  const bySchema = new Map<string, ResourceProvider>();
  for (const p of providers) {
    if (bySchema.has(p.scheme)) {
      // Duplicate scheme — take the first; log a warning. The operator
      // shouldn't ship two providers claiming the same scheme.
      console.warn(
        `[resources] duplicate scheme "${p.scheme}" — keeping first provider, ignoring second`
      );
      continue;
    }
    bySchema.set(p.scheme, p);
  }

  // Cast through — we documented above why this is loose.
  const s = server as {
    server?: {
      setRequestHandler: (method: string, cb: (req: unknown) => Promise<unknown>) => void;
      registerCapabilities?: (caps: Record<string, unknown>) => void;
    };
  };
  const rpc = s.server;
  if (!rpc || typeof rpc.setRequestHandler !== "function") {
    console.warn(
      "[resources] server has no setRequestHandler — not an MCP Server instance; skipping"
    );
    return;
  }

  try {
    // The SDK refuses resources/* handlers unless the server advertises the
    // `resources` capability ("Server does not support resources"). McpServer
    // only declares it when resources go through its own registerResource()
    // API, so declare it here (allowed before the transport connects). Before
    // this, resources/list answered "Method not found" for every connector.
    if (typeof rpc.registerCapabilities === "function") {
      rpc.registerCapabilities({ resources: {} });
    }

    rpc.setRequestHandler("resources/list", async () => {
      const all: ResourceSpec[] = [];
      for (const p of providers) {
        try {
          const list = await p.list();
          all.push(...list);
        } catch (err) {
          console.warn(
            `[resources] provider "${p.scheme}" list() threw: ${toMsg(err)} — returning partial list`
          );
        }
      }
      return { resources: all };
    });

    rpc.setRequestHandler("resources/read", async (req: unknown) => {
      const uri = (req as { params?: { uri?: string } })?.params?.uri;
      if (!uri || typeof uri !== "string") {
        throw new ResourceDispatchError("missing 'uri' param", "invalid_request");
      }
      const idx = uri.indexOf("://");
      if (idx < 1) {
        throw new ResourceDispatchError(`malformed URI: ${uri}`, "invalid_uri");
      }
      const scheme = uri.slice(0, idx);
      const provider = bySchema.get(scheme);
      if (!provider) {
        throw new ResourceDispatchError(
          `unknown scheme "${scheme}" — no provider registered`,
          "unknown_scheme"
        );
      }
      const content = await provider.read(uri);
      return { contents: [content] };
    });
  } catch (err) {
    console.warn(
      `[resources] failed to wire SDK request handlers: ${toMsg(err)} — resources/* will be unavailable`
    );
  }
}

/**
 * Test-only helper: synthesize a fake MCP server whose setRequestHandler
 * captures handlers for later invocation. Keeps resources-registry tests
 * out of the SDK's transport + session layer.
 */
export function __testMockServer(): {
  server: {
    setRequestHandler: (method: string, cb: (req: unknown) => Promise<unknown>) => void;
  };
  handlers: Map<string, (req: unknown) => Promise<unknown>>;
} {
  const handlers = new Map<string, (req: unknown) => Promise<unknown>>();
  return {
    server: {
      setRequestHandler: (method, cb) => {
        handlers.set(method, cb);
      },
    },
    handlers,
  };
}
