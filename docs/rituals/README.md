# Rituals

Rituals are ready-made skills for the things that come back every day or every week. Kebab House ships six templates; your own skills stay private, these are only starting points.

| Ritual                            | Say…                                        | Uses                           | Saves to               |
| --------------------------------- | ------------------------------------------- | ------------------------------ | ---------------------- |
| [Remember](remember.md)           | “remember that…”, “note that…”              | profile, vault                 | profile or `Inbox/`    |
| [Morning brief](morning-brief.md) | “morning brief”, “what's on today?”         | profile, calendar, mail, vault | `Journal/` (optional)  |
| [Meeting prep](meeting-prep.md)   | “prep my meeting with…”                     | profile, calendar, mail, vault | `Meetings/` (optional) |
| [Weekly review](weekly-review.md) | “weekly review”, “what did I do this week?” | weekly recap, profile, vault   | `Reviews/`             |
| [Read later](read-later.md)       | “read later” + a link                       | profile, `save_article`, vault | `Reading/`             |
| [Handoff](handoff.md)             | “hand this off”, “pick up where I left off” | vault                          | `Handoffs/`            |

## Install

- **From your AI client**: say “Set up my Kebab House”; step 3 suggests the rituals that fit your week. Or ask for one directly (`skill_template_install { name: "morning-brief" }`).
- **From the dashboard**: _Skills → Templates → Install_.
- **Browse them**: the `skills_gallery` tool shows installed skills and templates, with an _Install_ button in clients that render cards.

Once installed, a ritual is a normal skill: edit it in the dashboard to fit how you work (folders, tone, sources). Reinstalling a template over an edited skill replaces its text with the template's; your version stays in the skill's history, one click away from a rollback.

Every ritual degrades gracefully: when a tool is missing (no calendar in this client, no vault), it says what it skipped instead of inventing.

To make rituals trigger on their own in claude.ai, Claude Desktop and ChatGPT, upload the master relay skill once — see [Connect your clients](../CLIENTS.md#skills-in-clients-that-ignore-server-instructions).

## Make it a habit

A ritual only helps if you run it. Kebab House never starts a conversation on its own, so the trigger is yours:

- **Keep the phrase short and the same.** “morning brief”, “weekly review”, “hand this off”. Pin it where you start your day: a note, a text snippet, your client's saved prompts if it has them.
- **Tie it to a moment you already have.** The first coffee for the morning brief, Friday afternoon for the weekly review, closing your laptop for a handoff.
- **Let your client schedule it, if it can.** Some AI clients offer scheduled or recurring tasks; if yours does, create one with the ritual's phrase (for example “morning brief” on weekday mornings). Kebab House only answers the call: the schedule lives in your client.
- **Start with one.** Install one ritual, use it for a week, then adjust its text in *Skills* to fit how you work before adding the next.
