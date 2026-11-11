# Spec — Unipile messaging v2: provider interface + full LinkedIn / WhatsApp surface

- **Status:** Implemented (v0.22)
- **Owner:** Kebab maintainers
- **Related:** [ADR 0001](../adr/0001-unipile-as-linkedin-whatsapp-write-provider.md), [ADR 0002](../adr/0002-messaging-provider-interface.md), [connector doc](../connectors/unipile.md)

## 1. Goal

Make Kebab MCP the single place from which any AI client (Claude, ChatGPT, Cursor, agents) can **read, search, draft and send** on the operator's personal **WhatsApp** and do the day-to-day **LinkedIn networking / prospection** actions — once `UNIPILE_DSN` + `UNIPILE_TOKEN` are set.

Secondary goal: put every new tool behind a **provider-agnostic interface** so Unipile can be replaced (LinkupAPI, a self-hosted WAHA, …) by writing one adapter, without touching tools, guards or tests of the tool layer.

## 2. Non-goals (v2)

- Migrating the 6 pre-existing LinkedIn write tools (`send_connection`, `send_message`, `send_inmail`, `engage`, `get_relationship_status`, `list_pending`) onto the provider. They keep calling the SDK directly; tracked as phase 2 in ADR 0002.
- Proactive agents (daily digests, auto-replies). The read tools make them possible; scheduling is out of scope.
- Media download / voice-note transcription.
- Storing message bodies anywhere in Kebab (GDPR posture of ADR 0001 / D-64 unchanged).

## 3. Architecture

```
tools/*.ts ──► provider/index.ts  getMessagingProvider()  ──►  provider/unipile.ts (UnipileMessagingProvider)
    │                 (env KEBAB_MESSAGING_PROVIDER, default "unipile";               │
    │                  test override __setMessagingProviderForTests)                  └─► unipile-node-sdk
    └─► lib/write-guard.ts  (confirm → kill-switch → account → halt → dedup → rate-limit → execute → verify → audit)
```

- `provider/types.ts` — normalized, SDK-free shapes (`ProviderAccount`, `ProviderChat`, `ProviderMessage`, `ProviderContact`, `LinkedinProfile`, `LinkedinCompany`, `LinkedinPost`, `LinkedinConnection`, `LinkedinSearchResult`) and two interfaces: `MessagingProvider` (channel-agnostic chats/messages/contacts/send) and `LinkedinNetworkProvider` (profiles, relations, posts, invitations, search). One object may implement both.
- `provider/unipile.ts` — the only file of the new surface that imports the SDK. Applies `withRetry` to reads. **Sends are retried only on 429** (request rejected before processing) — never on 502/503/504, where the message may already be out (no double-send).
- `lib/account.ts` and `lib/read-helpers.ts` (`paginateChats`) now go through the provider; behaviour unchanged (existing tests stay green).
- `lib/write-guard.ts` — one shared pipeline for every new write tool, so the safety rules are written once.

## 4. Safety rules (apply to every new write tool)

| Rule | Behaviour |
|---|---|
| **R1 Confirm** | `confirm` defaults to `false` → the tool returns a **preview** (`executed:false`, resolved recipient / chat name / post, exact text) and does nothing else: no audit row, no rate-limit increment. Only `confirm:true` executes. Anything visible to other people (message, reply, comment, reaction, post, invitation withdrawal) requires it. |
| **R2 Kill switch** | `KEBAB_UNIPILE_WRITES_DISABLED=true` stops all Unipile writes (LinkedIn + WhatsApp). Channel switches: `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` (existing) and `KEBAB_UNIPILE_WHATSAPP_WRITES_DISABLED` (new). Checked first, even before preview. |
| **R3 Halt flag** | Account flagged by the `account_status` webhook → `error_account_halted`. |
| **R4 Short dedup** | Same (tool, account, target, text) within **10 min** → `dedup_hit:true`, not re-sent. The slot is claimed **atomically before** the provider call (`SET NX`), so two parallel identical calls cannot both send. A definite 4xx rejection or a Kebab-side rate-limit refusal frees the slot (retry allowed); an ambiguous failure (5xx / timeout — may have been delivered) keeps it. Short on purpose: "Merci !" twice in a week is legitimate on WhatsApp. |
| **R5 Rate limit** | Fail-closed KV counters (existing limiter). New keys and defaults: `whatsapp_send` 100/day, `linkedin_post_engagement` (comment + react) 40/day, `linkedin_post` 3/day, `linkedin_cancel_invitation` 30/day. `linkedin_reply` shares the existing `send_message` LinkedIn DM cap (50/day). Each is env-overridable. |
| **R6 Audit** | One audit row per confirmed attempt — executed or refused (kill switch, account, pre-flight, halt, dedup, rate limit) — 90-day TTL, **hash only** (never the text). Previews are not audited. |
| **R7 Verify** | Message sends are verified by polling the chat (3 s, then 7 s) for an outbound message newer than the request. `verified` is strictly boolean; not seen → `verified:false, error:"unverified_timeout"`. Non-message writes are verified by the provider's 2xx. |
| **R8 Webhook hygiene** | `message_received` events from WhatsApp accounts are dropped at the dispatcher: personal WhatsApp groups would otherwise write one KV audit row per inbound message (Upstash quota burn, no business value). |

## 5. Tool catalogue (13 new → connector total 23)

### WhatsApp

| Tool | Kind | Input | Output |
|---|---|---|---|
| `whatsapp_find_chat` | read | `query` (name fragment or phone digits), `limit`, `scan_limit` | `{chats:[{chat_id,name,conversation_type,provider_id,last_message_at,unread_count}], contacts:[{contact_id,name,provider_id,phone}]}` — accent/case-insensitive; phone match on digits |
| `whatsapp_search_messages` | read | `query`, optional `chat_id`, `since_days` (default 30, max 365), `limit` | `{matches:[{chat_id,chat_name,message_id,direction,sender_id,text,sent_at}], scanned, truncated}` — all terms must match; Kebab-side scan bounded to 1000 messages (Unipile has no full-text search) |
| `whatsapp_send_message` | write | `chat_id` **xor** `phone`, `text` (≤4096), optional `attachments` (≤5, ≤15 MB), `confirm` | preview or `{executed,provider_ok,verified,chat_id,message_id,audit_id,…}`. `phone` starts/reuses a 1:1 chat (`<digits>@s.whatsapp.net`). |

Existing: `whatsapp_list_inbox`, `whatsapp_read_messages` (now via provider).

### LinkedIn

| Tool | Kind | Notes |
|---|---|---|
| `linkedin_search_messages` | read | Same engine as `whatsapp_search_messages`, on the LinkedIn inbox. |
| `linkedin_reply` | write | Send into an existing conversation by `chat_id` (from `linkedin_list_inbox`) — works for any thread (1st-degree DM, InMail reply, group). Complements `linkedin_send_message`, which targets a profile URL. |
| `linkedin_get_profile` | read | `identifier` = profile URL / public id / company URL. Person → name, headline, location, degree, connections, summary, current positions, provider_id. Company → name, tagline, industry, size, website, followers. |
| `linkedin_list_connections` | read | 1st-degree connections (paginated), optional `query` filter on name/headline. |
| `linkedin_search` | read | `keywords` or a LinkedIn search `url`, `category` people/companies, `limit`. Uses Unipile `POST /linkedin/search` (raw endpoint, not in SDK). |
| `linkedin_list_posts` | read | Recent posts of a profile or company → `post_id` (social id), text, date, counters, url. |
| `linkedin_react_post` | write | Like/celebrate/support/love/insightful/funny on a post (URL, urn or social id). |
| `linkedin_comment_post` | write | Comment on a post. |
| `linkedin_create_post` | write | Publish a text post from the account. |
| `linkedin_cancel_invitation` | write | Withdraw a pending invitation (`invitation_id` from `linkedin_list_pending`). |

Post identifiers accepted: `urn:li:activity:<id>` / `urn:li:ugcPost:<id>` / `urn:li:share:<id>`, a raw social id, or any post URL containing `activity-<id>` / `urn:li:activity:<id>`.

## 6. Connector-level changes

- `testConnection` / `diagnose`: OK when **≥1 LinkedIn or WhatsApp** account is connected (was LinkedIn-only — a WhatsApp-only token was reported as broken). Message lists both counts.
- Manifest description + guide updated to the full surface; `registry.ts` toolCount 23; contract snapshot regenerated; docs (`docs/connectors/unipile.md`, `content/docs/connectors.md`) updated.
- Bug fix found during review: `linkedin_send_inmail` passed `path` as a string to `client.request.send` (SDK expects `string[]`), so the balance pre-flight always threw.

## 7. Provider swap procedure (Plan B)

1. Write `provider/<name>.ts` implementing `MessagingProvider` (+ `LinkedinNetworkProvider` if the vendor covers LinkedIn).
2. Register it in `provider/index.ts` under a new `KEBAB_MESSAGING_PROVIDER` value.
3. Run the provider contract test (`provider/__tests__/unipile.test.ts` is the template) against the new adapter.
No tool, guard or manifest change is needed for the 13 new tools + the 2 WhatsApp readers + the 2 LinkedIn inbox readers.

## 8. Acceptance criteria

1. `npm run typecheck`, `lint`, `format:check`, `lint:unused`, unit tests, `test:registry`, `test:contract`, `test:doc-counts` pass.
2. Every new tool has unit tests: happy path, account errors, preview-without-confirm (no side effects), kill switch, halt, dedup, rate limit, provider failure, verify true/false.
3. The adapter has its own tests mapping SDK payloads → normalized shapes, and asserting sends are not retried on 5xx.
4. With real credentials: `whatsapp_find_chat("…")` → `whatsapp_read_messages` → `whatsapp_send_message` preview → `confirm:true` delivers once.

## 9. Review log

Independent review (pre-merge) found and fixed: non-atomic dedup (parallel double-send), ambiguous-failure retry double-send, account missing from the dedup key, unaudited confirmed refusals, `ugcPost`/`share` post URLs not parsed (raw URL forwarded as a path segment), national-format phone search, WhatsApp kill switch not surfaced in /config.

## 10. Risks

- **Unverified vendor shapes** (docs unreachable from the build environment): `/linkedin/search` body and WhatsApp `@s.whatsapp.net` attendee ids follow Unipile's public docs from memory. Mitigated by defensive parsing + explicit error envelopes; to be checked on first live use (criterion 4).
- **Account bans**: unofficial channels on both networks. Mitigated by R1–R5; defaults are conservative.
