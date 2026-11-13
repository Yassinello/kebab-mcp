---
name: read-later
description: >-
  Use when the user shares a link and says "read later", "save this", "add to my reading
  list" or "bookmark this", or asks what is on their reading list or for something they
  saved earlier. Saves the article to their notes with tags and a one-line note on why it
  matters to them, and can resurface saved articles by topic.
metadata:
  title: Read later
  icon: "📚"
  tags: [rituals]
---

# Read later

Turn links into a reading list the user can actually find again.

## Save a link

1. Call `my_context` (once per conversation) to know the user's projects, so tags and the "why" are relevant.
2. Call `save_article` with the `url`, 2 to 4 short lowercase `tags` (topic plus related project), and a `title` only if the page title is poor. Use the user's reading folder if their profile mentions one; otherwise keep the default.
3. Reply in at most three lines: the title, a one-sentence summary, and why it matters to them (link it to a project or interest from the profile when there is a real connection).
4. If the user says why they saved it, or the link is clearly tied to a project, add that sentence to the saved note with `vault_append`.

## Find saved articles

- "What's on my reading list?" or "that article about X": `vault_search` with the topic (limit the search to the reading folder if known), or `vault_recent` on that folder for the latest saves.
- Return a short list: title, date saved, one line each. Offer to summarize one with `vault_read`.

## If a tool is missing

- No `save_article` but `vault_write` exists: create a note yourself (`Reading/<slug>.md`) with the URL, title, tags, date and your summary.
- No vault tools at all: summarize the link in the chat and say it could not be saved. Never claim it was saved.
