/**
 * credentials-step unit tests — PIPE-02.
 *
 * Covers:
 *  - hydrateCredentialsFromKV is called and snapshot is seeded on ctx.credentials
 *  - next() runs inside runWithCredentials so the handler sees getCredential() values
 *  - Credentials don't leak across requests (fresh ctx per pipeline invocation)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hydrateMock = vi.fn(async () => {});
const snapshotMock = vi.fn(() => ({}) as Record<string, string>);

vi.mock("@/core/credential-store", () => ({
  hydrateCredentialsFromKV: () => hydrateMock(),
  invalidateCredentialsIfRevisionChanged: vi.fn(),
  getHydratedCredentialSnapshot: () => snapshotMock(),
}));

import { composeRequestPipeline } from "@/core/pipeline";
import { hydrateCredentialsStep } from "@/core/pipeline/credentials-step";
import { getCredential } from "@/core/request-context";

describe("hydrateCredentialsStep (PIPE-02)", () => {
  beforeEach(() => {
    hydrateMock.mockReset();
    hydrateMock.mockResolvedValue(undefined);
    snapshotMock.mockReset();
    snapshotMock.mockReturnValue({});
  });

  it("awaits hydrateCredentialsFromKV, writes snapshot to ctx.credentials, runs next under runWithCredentials", async () => {
    snapshotMock.mockReturnValue({ SLACK_BOT_TOKEN: "xoxb-from-kv" });

    let credentialsSeenByHandler: string | undefined;
    const pipeline = composeRequestPipeline([hydrateCredentialsStep], async (ctx) => {
      // ctx.credentials is set
      expect(ctx.credentials).toEqual({ SLACK_BOT_TOKEN: "xoxb-from-kv" });
      // ambient request-context override is active
      credentialsSeenByHandler = getCredential("SLACK_BOT_TOKEN");
      return new Response("ok");
    });

    await pipeline(new Request("https://test.local/api/mcp"));
    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(credentialsSeenByHandler).toBe("xoxb-from-kv");
  });

  it("a subsequent request without credentials does NOT inherit the previous request's creds", async () => {
    // First request seeds SLACK
    snapshotMock.mockReturnValueOnce({ SLACK_BOT_TOKEN: "first-token" });
    const pipeline = composeRequestPipeline([hydrateCredentialsStep], async () => {
      return new Response("ok");
    });
    await pipeline(new Request("https://test.local/api/mcp"));

    // Second request: snapshot now returns empty
    snapshotMock.mockReturnValueOnce({});
    let seen: string | undefined = "unset";
    const pipeline2 = composeRequestPipeline([hydrateCredentialsStep], async () => {
      seen = getCredential("SLACK_BOT_TOKEN");
      return new Response("ok");
    });
    await pipeline2(new Request("https://test.local/api/mcp"));
    // process.env.SLACK_BOT_TOKEN is undefined in the test harness, and the
    // request-scoped override is empty — getCredential returns undefined.
    expect(seen).toBeUndefined();
  });

  it("empty snapshot is handled (no creds to merge)", async () => {
    snapshotMock.mockReturnValue({});
    const pipeline = composeRequestPipeline([hydrateCredentialsStep], async (ctx) => {
      expect(ctx.credentials).toEqual({});
      return new Response("ok", { status: 200 });
    });
    const res = await pipeline(new Request("https://test.local/api/mcp"));
    expect(res.status).toBe(200);
  });
});
