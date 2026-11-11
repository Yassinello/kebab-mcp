/**
 * LinkedIn networking surface (spec v2 §5) — reads + guarded writes.
 *
 * Reads (runRead — never throw, `{error}` envelope on failure):
 *   linkedin_get_profile, linkedin_list_connections, linkedin_search,
 *   linkedin_list_posts
 * Writes (runGuardedWrite — preview unless confirm:true):
 *   linkedin_react_post, linkedin_comment_post, linkedin_create_post,
 *   linkedin_cancel_invitation
 */

import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { resolveAccountIdForType } from "../lib/account";
import { runRead } from "../lib/read-helpers";
import {
  accountArg,
  accountIdField,
  actorUserIdField,
  confirmField,
  jsonResult,
} from "../lib/common-schema";
import { matchesAllTerms, queryTerms } from "../lib/text-match";
import { runGuardedWrite, type PrepareResult } from "../lib/write-guard";
import { getMessagingProvider, type LinkedinReaction } from "../provider";
import { isCompanyUrl } from "../provider/unipile";

const accountField = accountIdField("LinkedIn");

async function linkedinAccount(
  accountId: string | undefined
): Promise<{ accountId: string } | { error: string; available_accounts?: string[] }> {
  return resolveAccountIdForType("LINKEDIN", accountArg(accountId));
}

function accountError(e: { error: string; available_accounts?: string[] }, empty: object) {
  return jsonResult({
    ...empty,
    error: e.error,
    ...(e.available_accounts ? { available_accounts: e.available_accounts } : {}),
  });
}

// ── linkedin_get_profile ──

export const linkedinGetProfileSchema = {
  identifier: z
    .string()
    .min(2)
    .max(500)
    .describe(
      "Person: profile URL (linkedin.com/in/…), public id or provider id. Company: company URL (linkedin.com/company/…)."
    ),
  account_id: accountField,
};

export async function handleLinkedinGetProfile(args: {
  identifier: string;
  account_id?: string;
}): Promise<ToolResult> {
  return runRead("linkedin_get_profile", { profile: null }, async () => {
    const acct = await linkedinAccount(args.account_id);
    if ("error" in acct) return accountError(acct, { profile: null });
    const provider = getMessagingProvider();
    const profile = isCompanyUrl(args.identifier)
      ? await provider.getCompany({ accountId: acct.accountId, identifier: args.identifier })
      : await provider.getProfile({ accountId: acct.accountId, identifier: args.identifier });
    return jsonResult({ profile });
  });
}

// ── linkedin_list_connections ──

export const linkedinListConnectionsSchema = {
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Optional filter on name + headline (all words must match, accents ignored), e.g. 'cto saas'."
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .default(50)
    .describe("Max connections returned (default 50)."),
  scan_limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .default(500)
    .describe("With a query: how many most-recent connections to scan (default 500, max 1000)."),
  account_id: accountField,
};

export async function handleLinkedinListConnections(args: {
  query?: string;
  limit?: number;
  scan_limit?: number;
  account_id?: string;
}): Promise<ToolResult> {
  return runRead("linkedin_list_connections", { count: 0, items: [] }, async () => {
    const acct = await linkedinAccount(args.account_id);
    if ("error" in acct) return accountError(acct, { count: 0, items: [] });
    const limit = args.limit ?? 50;
    const terms = args.query ? queryTerms(args.query) : [];
    const fetchCount = terms.length > 0 ? (args.scan_limit ?? 500) : limit;
    const all = await getMessagingProvider().listConnections({
      accountId: acct.accountId,
      limit: fetchCount,
    });
    const filtered =
      terms.length > 0
        ? all.filter((c) =>
            matchesAllTerms(`${c.firstName ?? ""} ${c.lastName ?? ""} ${c.headline ?? ""}`, terms)
          )
        : all;
    const items = filtered.slice(0, limit);
    return jsonResult({ count: items.length, scanned: all.length, items });
  });
}

// ── linkedin_search ──

export const linkedinSearchSchema = {
  keywords: z
    .string()
    .min(2)
    .max(300)
    .optional()
    .describe("Search keywords, e.g. 'head of operations logistics Lyon'."),
  url: z
    .string()
    .url()
    .optional()
    .describe(
      "Alternative: a LinkedIn (or Sales Navigator) search URL copied from the browser, filters included."
    ),
  category: z
    .enum(["people", "companies"])
    .default("people")
    .describe("What to search (with keywords)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .default(10)
    .describe("Max results (default 10, max 50)."),
  account_id: accountField,
};

export async function handleLinkedinSearch(args: {
  keywords?: string;
  url?: string;
  category?: "people" | "companies";
  limit?: number;
  account_id?: string;
}): Promise<ToolResult> {
  return runRead("linkedin_search", { count: 0, items: [] }, async () => {
    if (!args.keywords && !args.url) {
      return jsonResult({
        count: 0,
        items: [],
        error: "error_invalid_request",
        detail: "Provide keywords or url.",
      });
    }
    const acct = await linkedinAccount(args.account_id);
    if ("error" in acct) return accountError(acct, { count: 0, items: [] });
    const items = await getMessagingProvider().search({
      accountId: acct.accountId,
      category: args.category ?? "people",
      limit: args.limit ?? 10,
      ...(args.url ? { url: args.url } : {}),
      ...(args.keywords ? { keywords: args.keywords } : {}),
    });
    return jsonResult({ count: items.length, items });
  });
}

// ── linkedin_list_posts ──

export const linkedinListPostsSchema = {
  identifier: z
    .string()
    .min(2)
    .max(500)
    .describe("Profile URL / public id (person) or company URL (linkedin.com/company/…)."),
  limit: z.number().int().positive().max(50).default(10).describe("Max posts (default 10)."),
  account_id: accountField,
};

export async function handleLinkedinListPosts(args: {
  identifier: string;
  limit?: number;
  account_id?: string;
}): Promise<ToolResult> {
  return runRead("linkedin_list_posts", { count: 0, items: [] }, async () => {
    const acct = await linkedinAccount(args.account_id);
    if ("error" in acct) return accountError(acct, { count: 0, items: [] });
    const items = await getMessagingProvider().listPosts({
      accountId: acct.accountId,
      identifier: args.identifier,
      isCompany: isCompanyUrl(args.identifier),
      limit: args.limit ?? 10,
    });
    return jsonResult({ count: items.length, items });
  });
}

// ── guarded writes ──

const postField = z
  .string()
  .min(3)
  .max(1000)
  .describe("Post URL, urn (urn:li:activity:…) or post_id from linkedin_list_posts.");

export const linkedinReactPostSchema = {
  post: postField,
  reaction: z
    .enum(["like", "celebrate", "support", "love", "insightful", "funny"])
    .default("like")
    .describe("Reaction type (default like)."),
  confirm: confirmField,
  account_id: accountField,
  actor_user_id: actorUserIdField,
};

export async function handleLinkedinReactPost(args: {
  post: string;
  reaction?: LinkedinReaction;
  confirm?: boolean;
  account_id?: string;
  actor_user_id?: string;
}): Promise<ToolResult> {
  const reaction = args.reaction ?? "like";
  let postId = "";
  return runGuardedWrite({
    tool: "linkedin_react_post",
    channel: "LINKEDIN",
    rateKey: "linkedin_post_engagement",
    accountId: args.account_id,
    actorUserId: args.actor_user_id ?? "mcp",
    confirm: args.confirm === true,
    dedupMaterial: { post: args.post, reaction },
    prepare: async (accountId): Promise<PrepareResult> => {
      postId = await getMessagingProvider().resolvePostId({ accountId, post: args.post });
      return { ok: true, preview: { action: "react", post_id: postId, reaction } };
    },
    execute: async (accountId) => {
      await getMessagingProvider().reactPost({ accountId, postId, reaction });
      return { fields: { post_id: postId, reaction }, verified: true };
    },
  });
}

export const linkedinCommentPostSchema = {
  post: postField,
  text: z.string().min(1).max(1250).describe("Comment text (≤1250 chars)."),
  confirm: confirmField,
  account_id: accountField,
  actor_user_id: actorUserIdField,
};

export async function handleLinkedinCommentPost(args: {
  post: string;
  text: string;
  confirm?: boolean;
  account_id?: string;
  actor_user_id?: string;
}): Promise<ToolResult> {
  let postId = "";
  return runGuardedWrite({
    tool: "linkedin_comment_post",
    channel: "LINKEDIN",
    rateKey: "linkedin_post_engagement",
    accountId: args.account_id,
    actorUserId: args.actor_user_id ?? "mcp",
    confirm: args.confirm === true,
    dedupMaterial: { post: args.post, text: args.text },
    prepare: async (accountId): Promise<PrepareResult> => {
      postId = await getMessagingProvider().resolvePostId({ accountId, post: args.post });
      return { ok: true, preview: { action: "comment", post_id: postId, text: args.text } };
    },
    execute: async (accountId) => {
      await getMessagingProvider().commentPost({ accountId, postId, text: args.text });
      return { fields: { post_id: postId }, verified: true };
    },
  });
}

export const linkedinCreatePostSchema = {
  text: z
    .string()
    .min(1)
    .max(3000)
    .describe("Post text (≤3000 chars). Published publicly from the account."),
  confirm: confirmField,
  account_id: accountField,
  actor_user_id: actorUserIdField,
};

export async function handleLinkedinCreatePost(args: {
  text: string;
  confirm?: boolean;
  account_id?: string;
  actor_user_id?: string;
}): Promise<ToolResult> {
  return runGuardedWrite({
    tool: "linkedin_create_post",
    channel: "LINKEDIN",
    rateKey: "linkedin_post",
    accountId: args.account_id,
    actorUserId: args.actor_user_id ?? "mcp",
    confirm: args.confirm === true,
    dedupMaterial: { text: args.text },
    prepare: async (): Promise<PrepareResult> => ({
      ok: true,
      preview: { action: "publish_post", visibility: "public", text: args.text },
    }),
    execute: async (accountId) => {
      const { postId } = await getMessagingProvider().createPost({ accountId, text: args.text });
      return { fields: { post_id: postId }, verified: true };
    },
  });
}

export const linkedinCancelInvitationSchema = {
  invitation_id: z
    .string()
    .min(1)
    .max(200)
    .describe("Pending invitation id from linkedin_list_pending."),
  confirm: confirmField,
  account_id: accountField,
  actor_user_id: actorUserIdField,
};

export async function handleLinkedinCancelInvitation(args: {
  invitation_id: string;
  confirm?: boolean;
  account_id?: string;
  actor_user_id?: string;
}): Promise<ToolResult> {
  return runGuardedWrite({
    tool: "linkedin_cancel_invitation",
    channel: "LINKEDIN",
    rateKey: "linkedin_cancel_invitation",
    accountId: args.account_id,
    actorUserId: args.actor_user_id ?? "mcp",
    confirm: args.confirm === true,
    dedupMaterial: { invitation_id: args.invitation_id },
    prepare: async (): Promise<PrepareResult> => ({
      ok: true,
      preview: {
        action: "withdraw_invitation",
        invitation_id: args.invitation_id,
        note: "LinkedIn blocks re-inviting the same person for ~3 weeks after a withdrawal.",
      },
    }),
    execute: async (accountId) => {
      await getMessagingProvider().cancelInvitation({
        accountId,
        invitationId: args.invitation_id,
      });
      return { fields: { invitation_id: args.invitation_id }, verified: true };
    },
  });
}
