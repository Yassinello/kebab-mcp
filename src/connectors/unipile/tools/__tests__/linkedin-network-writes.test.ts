/**
 * Spec v2 — LinkedIn guarded writes: react, comment, create post, cancel invitation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeMemoryKV, makeFakeProvider, parse } from "../../__tests__/fakes";

const { kv, config } = vi.hoisted(() => ({
  kv: {
    current: null as unknown as ReturnType<typeof import("../../__tests__/fakes").makeMemoryKV>,
  },
  config: new Map<string, string>(),
}));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kv.current,
  getCurrentTenantId: () => "t1",
}));
vi.mock("@/core/config-facade", () => ({
  getConfig: (k: string) => config.get(k),
  getConfigInt: (k: string, d: number) => (config.has(k) ? Number(config.get(k)) : d),
}));

import { __setMessagingProviderForTests } from "../../provider";
import {
  handleLinkedinReactPost,
  handleLinkedinCommentPost,
  handleLinkedinCreatePost,
  handleLinkedinCancelInvitation,
} from "../linkedin-network";

let provider: ReturnType<typeof makeFakeProvider>;
const POST = "https://www.linkedin.com/posts/jane_activity-7000000000000000001-abcd";

beforeEach(() => {
  kv.current = makeMemoryKV();
  config.clear();
  provider = makeFakeProvider();
  __setMessagingProviderForTests(provider);
});
afterEach(() => __setMessagingProviderForTests(null));

describe("linkedin_react_post", () => {
  it("preview resolves the post id and does not react", async () => {
    const env = parse<{ preview: Record<string, unknown>; executed: boolean }>(
      await handleLinkedinReactPost({ post: POST })
    );
    expect(env.executed).toBe(false);
    expect(env.preview).toMatchObject({
      action: "react",
      post_id: "urn:li:activity:7000000000000000001",
      reaction: "like",
    });
    expect(provider.reactPost).not.toHaveBeenCalled();
  });

  it("confirm reacts with the resolved id and counts toward the engagement cap", async () => {
    const env = parse<{ executed: boolean; verified: boolean }>(
      await handleLinkedinReactPost({ post: POST, reaction: "celebrate", confirm: true })
    );
    expect(env).toMatchObject({ executed: true, verified: true });
    expect(provider.reactPost).toHaveBeenCalledWith({
      accountId: "li1",
      postId: "urn:li:activity:7000000000000000001",
      reaction: "celebrate",
    });
    expect(kv.current.incr).toHaveBeenCalledWith(
      expect.stringContaining(":linkedin_post_engagement:"),
      expect.anything()
    );
  });

  it("unresolvable post → error envelope, nothing sent", async () => {
    provider.resolvePostId.mockRejectedValue(new Error("not found"));
    const env = parse<{ error: string; executed: boolean }>(
      await handleLinkedinReactPost({ post: "garbage", confirm: true })
    );
    expect(env.executed).toBe(false);
    expect(env.error).toBeDefined();
    expect(provider.reactPost).not.toHaveBeenCalled();
  });
});

describe("linkedin_comment_post", () => {
  it("comment cap shared with reactions", async () => {
    config.set("KEBAB_UNIPILE_LINKEDIN_DAILY_ENGAGEMENT_CAP", "1");
    await handleLinkedinReactPost({ post: POST, confirm: true });
    const env = parse<{ error: string }>(
      await handleLinkedinCommentPost({ post: POST, text: "Great point!", confirm: true })
    );
    expect(env.error).toBe("error_rate_limit_kebab");
    expect(provider.commentPost).not.toHaveBeenCalled();
  });

  it("confirm comments", async () => {
    await handleLinkedinCommentPost({ post: POST, text: "Great point!", confirm: true });
    expect(provider.commentPost).toHaveBeenCalledWith({
      accountId: "li1",
      postId: "urn:li:activity:7000000000000000001",
      text: "Great point!",
    });
  });
});

describe("linkedin_create_post", () => {
  it("preview shows public visibility; 3/day default cap", async () => {
    const prev = parse<{ preview: Record<string, unknown> }>(
      await handleLinkedinCreatePost({ text: "Hello" })
    );
    expect(prev.preview).toMatchObject({
      action: "publish_post",
      visibility: "public",
      text: "Hello",
    });
    for (const t of ["a", "b", "c"]) await handleLinkedinCreatePost({ text: t, confirm: true });
    const fourth = parse<{ error: string }>(
      await handleLinkedinCreatePost({ text: "d", confirm: true })
    );
    expect(fourth.error).toBe("error_rate_limit_kebab");
    expect(provider.createPost).toHaveBeenCalledTimes(3);
  });

  it("global kill switch stops posts", async () => {
    config.set("KEBAB_UNIPILE_WRITES_DISABLED", "true");
    const env = parse<{ error: string }>(
      await handleLinkedinCreatePost({ text: "x", confirm: true })
    );
    expect(env.error).toBe("error_writes_disabled");
  });
});

describe("linkedin_cancel_invitation", () => {
  it("preview warns about the re-invite cooldown; confirm withdraws once (dedup)", async () => {
    const prev = parse<{ preview: { note: string } }>(
      await handleLinkedinCancelInvitation({ invitation_id: "inv1" })
    );
    expect(prev.preview.note).toMatch(/3 weeks/);
    await handleLinkedinCancelInvitation({ invitation_id: "inv1", confirm: true });
    const again = parse<{ dedup_hit: boolean }>(
      await handleLinkedinCancelInvitation({ invitation_id: "inv1", confirm: true })
    );
    expect(again.dedup_hit).toBe(true);
    expect(provider.cancelInvitation).toHaveBeenCalledTimes(1);
    expect(provider.cancelInvitation).toHaveBeenCalledWith({
      accountId: "li1",
      invitationId: "inv1",
    });
  });
});
