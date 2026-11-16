---
title: Welcome to Kebab House
summary: What your hub does, a tour of the dashboard, and where to start
order: 1
---

## What Kebab House is

Kebab House is your personal AI hub: **one profile, one library of skills and one memory**, shared by every AI client you connect (Claude, ChatGPT, Cursor, Claude Code, Codex and any MCP client). Tell one client something, and the next one knows it. Write a skill once, and every client can use it.

It is a hub, not an agent: your AI clients do the thinking. Kebab House serves them your context and your tools when they ask, and keeps the risky parts under your control.

- **Profile** — who you are, what you work on, how you like answers. One profile per hat (work, home…), bound to the client that uses it.
- **Skills** — reusable instructions in the open Agent Skills format, plus ready-made rituals (remember, morning brief, meeting prep, weekly review, read later, handoff).
- **Memory** — notes every client can read and write: built in, or your own GitHub repository (Obsidian-friendly).
- **Clients** — each AI client signs in (or gets its own device token), with the access level you choose.
- **Guardrails** — outside content is labelled as data, outgoing messages wait for your approval, and every tool call is counted per client.
- **Tools** — only what your clients' own connectors lack: LinkedIn, WhatsApp, a real browser, paywalled articles, any HTTP API as a tool. Gmail, Slack or Notion are available too, but use your client's own connector when it has one.

If you just finished the Welcome wizard: say **“Set up my Kebab House”** in your AI client. A short interview writes your profile and suggests the rituals that fit your week. Then come back here to look at what it saved.

## The dashboard, tab by tab

### Overview

Your hub at a glance: setup checklist, connected clients, this week's activity, and warnings that need you (for example an AI client using your admin key instead of its own device token). The **updates banner** shows when a new Kebab House release is available, with an **Update now** button — see “I want to stay up to date” below.

### Profile

Read and edit what every client knows about you. Create one profile per hat (`work`, `perso`…) and bind each client to one in **Devices**. Earlier versions are kept, so you can restore one.

### Skills

Browse, edit and create skills. Each card has an **Actions** menu (Edit, History, Export, Delete); clicking the body opens the edit page. **Templates** installs the rituals; **Import** takes a `SKILL.md` or a `.zip` (from Claude, ChatGPT or a Git repo); **Use your skills in every AI client** gives the relay skill and the native copy for Claude Code and Codex.

→ See [Authoring skills](#skills).

### Memory

Your notes: search, read and edit what your clients saved (“remember this”, read-later, meeting notes, handoffs). Choose where notes live: built in (stored with your other data) or a GitHub repository.

### Connectors

Turn tools on by pasting their credentials. Each connector has a setup guide and a **Test connection** button that checks the credentials before you rely on them.

→ See [Connector setup](#connectors).

### Devices

One entry per AI client. Clients that signed in (OAuth) appear here on their own; **Add device** creates a device token for the others. For each client: its access level, its profile, which skill tags and connectors it sees, rename, rotate, revoke.

Your **admin key** opens this dashboard. Do not paste it into an AI client: give each client its own device token.

### Logs

Recent tool calls with time, client, duration and status. Filter by connector, tool or status. The weekly recap on Overview counts calls per client.

### Advanced

Less frequent, more technical:

- **Tools** — every registered tool, grouped by connector, each with its own on/off switch (turn off Gmail send while keeping Gmail read).
- **Playground** — run any tool with your own arguments and see the raw response and timing.
- **Health** — bootstrap state, storage latency, request counts, rate limits. Open it when something feels off and the Logs aren't enough.
- **Storage** — where your data lives (`Upstash Redis`, `Filesystem`, or a warning state), with migration and recovery. → See [Storage modes & data persistence](#storage).
- **Documentation** — these pages.
- **Settings** — display name, timezone, export / import of your data (profiles, skills, notes and settings, secrets excluded), and the Updates token.

## Where to start

### "I want my clients to know me"

1. In your AI client, say **“Set up my Kebab House”**.
2. Answer the short interview; it writes your **Profile**.
3. Open **Profile** here to check or edit it.

### "I want to connect another AI client"

1. Claude, ChatGPT, Cursor, Claude Code: add your instance URL (`https://<your-instance>/api/mcp`) and sign in. On the consent page, pick the access level: *read only*, *read + my profile and notes* (recommended) or *everything*.
2. Other clients: open **Devices → Add device** and paste the device token into the client.

### "I want to add a tool"

1. Open **Connectors** and pick the one you need.
2. Follow its setup guide, paste the credentials, click **Test connection**.
3. Once it shows green, its tools are available to every connected client (within each client's access level).

If the **Storage** badge is orange (`Filesystem (temporary)`), fix that first — your credentials would vanish otherwise. See [Storage](#storage).

### "I want to try a skill"

1. Open **Skills → Templates** and install a ritual (for example `morning-brief`).
2. In any connected client, say “morning brief”.
3. To test without a client: **Advanced → Playground**, pick the skill, run it.

### "I want to stay up to date"

1. Open **Advanced → Settings → Advanced → Updates**.
2. Paste a GitHub token with *Contents: read & write* on your Kebab House repository, click **Save token**, then **Test connection**.
3. Back on **Overview**, the updates banner shows whether a new release is available.

A daily check runs in the background; the ↻ icon forces a re-check. **Update now** copies the new release's files into your repository as one commit (or uses GitHub's *Sync fork* if your repository is a fork), and Vercel redeploys on its own. If you edited a file that the release also changes, nothing is written and the banner lists the files.

To turn the feature off, set `KEBAB_DISABLE_UPDATE_API=1` in your environment variables.

## When stuck

- Open **Logs** for the most recent call — the status column shows what went wrong.
- Read [Troubleshooting](#troubleshooting) for the most common issues, including storage problems.
- Read the [FAQ](#faq) for design questions.
- Still stuck? [Open an issue](https://github.com/Yassinello/kebab-mcp/issues) with your Kebab House version (sidebar footer), the connector involved, and the Logs entry if there is one.

## See also

→ [Getting started](#getting-started) — the deploy, if you skipped it
→ [Storage](#storage) — where your data lives and how durable it is
→ [Connector setup](#connectors) — credentials, connector by connector
