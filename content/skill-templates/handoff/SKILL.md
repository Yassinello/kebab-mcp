---
name: handoff
description: >-
  Use when the user says "hand this off", "continue in Cursor", "continue in ChatGPT",
  "continue in Claude Code", "save where we are", or later "pick up where I left off",
  "resume the handoff". Writes a short handoff note (goal, decisions, current state, next
  steps, links and files) to their notes so another AI client connected to Kebab House can
  continue the work, and loads a saved handoff when asked to resume.
metadata:
  title: Hand off
  summary: "Moves a conversation to another AI client: save where you are here, pick it up there."
  example: "Hand this off to Cursor"
  icon: "🔁"
  tags: [rituals]
---

# Hand off

Let the user stop in one AI client and continue in another without re-explaining anything. Every client connected to Kebab House reads the same notes.

## Save a handoff ("hand this off", "save where we are", "continue in …")

1. Call `my_context` (once per conversation) so the note uses the user's project names and follows their folder conventions.
2. Write the note from this conversation. Be concrete and short: the next client only knows what you write.

```
# Handoff: <topic>
**From**: <this client> · **For**: <target client, if named> · **Date**: <YYYY-MM-DD HH:MM>
**Goal**: what the user is trying to achieve, in one or two sentences.
**Decisions**: what was decided and why (bullets).
**Current state**: what is done, what is in progress, what is blocked.
**Next steps**: the first 3 to 5 concrete actions, in order.
**Links and files**: URLs, file paths, branches, note paths, with one line each.
**Open questions**: what still needs the user.
```

3. Save it with `vault_write` to `Handoffs/YYYY-MM-DD <topic>.md` (short topic, no special characters), or the folder their profile mentions.
4. Confirm in two lines: where it was saved, and what to say in the other client, e.g. "In Cursor, say: pick up where I left off."

Never put passwords, tokens or API keys in a handoff note, even if they appeared in the conversation.

## Resume a handoff ("pick up where I left off", "resume the handoff")

1. Find recent handoffs: `vault_recent` on the `Handoffs/` folder (about 5 notes). If the user names a topic, use `vault_search` with it instead.
2. If there is exactly one recent handoff, or the user named one, load it. Otherwise list them (date and topic, one line each) and ask which one.
3. Read the chosen note with `vault_read`, restate the goal and next steps in a few lines, and ask whether to start with the first next step.
4. When the work moves on, offer to update the note with the new state (`vault_write` with the note's sha), so the next handoff starts from it.

## If a tool is missing

- No `vault_write`: give the handoff in the chat as one block and tell the user to paste it in the other client. Never claim it was saved.
- No `vault_recent` or `vault_search` when resuming: ask the user for the note path, or to paste the handoff.
- No vault tools at all: say that handoffs need the notes vault, which can be turned on in the Kebab House dashboard.
