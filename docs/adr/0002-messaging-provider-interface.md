# ADR 0002 — Keep Unipile, behind a messaging provider interface

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** Yassine (Founder)
- **Scope:** `src/connectors/unipile/` (v0.22) — see [spec](../specs/unipile-messaging-v2.md)

## Context

Kebab already reads WhatsApp through Unipile (ADR 0001) but cannot search, send or start a WhatsApp conversation, and several everyday LinkedIn networking actions are missing (reply in a thread, profile lookup, posts, invitation withdrawal). The question was whether to complete the Unipile connector or adopt another gateway, given Unipile's €49/month entry price (1–10 accounts).

## Options benchmarked (Nov 2026)

| Option | WhatsApp | LinkedIn messaging | LinkedIn prospection (invite / InMail) | Cost / month | Works from Vercel | Verdict |
|---|---|---|---|---|---|---|
| **Unipile** | ✅ | ✅ | ✅ | €49 (≤10 accounts), then ~€5/account | ✅ | **Chosen** |
| LinkupAPI | ✅ | ✅ | ✅ | ~$55 (10 accounts) | ✅ | Same price, younger vendor → **Plan B** |
| Beeper Desktop API | ✅ | ✅ | ❌ | €0–10 | ⚠️ desktop app + tunnel, personal use only | Rejected: no prospection, not multi-user |
| Matrix + mautrix bridges | ✅ | ✅ | ❌ | ~€5 VPS | ✅ | Rejected: no prospection, heavy ops |
| WAHA Core (WA) + Apify actors (LI) | ✅ | ⚠️ | ⚠️ | ~€5–10 | ✅ | Rejected: cookie handed to third-party actors, silent-failure risk (ADR 0001 incident) |
| Linked API / gtm-api / UnAPI | ❌ | ✅ | ✅ | $39–69 per account | ✅ | LinkedIn-only, not cheaper |
| WhatsApp Business Cloud API | Business number only | — | — | per message | ✅ | Cannot read personal chats; Meta bars general-purpose AI assistants since 2026-01-15 |

All options using personal accounts carry the same ToS / restriction risk; no vendor removes it.

## Decision

1. Keep Unipile as the provider and complete the surface (13 new tools, see spec).
2. Introduce `src/connectors/unipile/provider/` — a provider-agnostic `MessagingProvider` + `LinkedinNetworkProvider` interface with a single Unipile adapter. All new tools, the WhatsApp readers, the LinkedIn inbox readers and the account resolver go through it.
3. Every new write tool runs through one shared guard (`lib/write-guard.ts`): preview unless `confirm:true`, kill switch, halt flag, 10-minute dedup, fail-closed rate limit, hash-only audit, verify-after-send.

## Consequences

- Swapping to LinkupAPI (or WAHA for WhatsApp only) = one new adapter file + one registry entry. Validate with a half-day POC on their trial the day Unipile degrades — not before.
- **Phase 2 (debt, accepted):** the six original LinkedIn tools still call the SDK directly. Migrate them onto the provider before a swap is actually executed.
- The connector id stays `unipile` so existing env vars, KV keys and token scopes keep working.

## Plan B triggers

- Unipile outage > 24 h, account bans attributable to Unipile, or a price increase > 2× → run the LinkupAPI POC, then switch `KEBAB_MESSAGING_PROVIDER`.
- Price-only issue on WhatsApp → WAHA self-hosted adapter for WhatsApp, Unipile kept for LinkedIn.
