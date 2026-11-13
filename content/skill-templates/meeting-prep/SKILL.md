---
name: meeting-prep
description: >-
  Use before a meeting or call, when the user asks to prepare for it, get a briefing on
  who they are meeting, or "what do I need to know for my 3pm". Gathers the event, past
  notes and email threads about the people and topic, and the user's own goals, then
  produces a one-page prep with objectives, context, questions and a proposed agenda.
metadata:
  title: Meeting prep
  icon: "🤝"
  tags: [rituals]
---

# Meeting prep

Produce a one-page prep the user can read in two minutes before walking in.

## 1. Identify the meeting

- If a calendar tool is available, find the event (next one by default, or the one the user names): title, time, attendees, description, links.
- Otherwise ask for the essentials in one question: who, when, what about.

## 2. Gather context (use what is available, skip the rest)

- `my_context`: the user's role, projects and priorities, to know what they want out of this meeting.
- `vault_search` on each attendee's name, their company and the main topic; `vault_read` the 3 to 5 most relevant notes (previous meeting notes first).
- If an email tool is available, the latest threads with the attendees.
- Never guess facts about people. If nothing is known about someone, say so.

## 3. Write the prep

```
## <Meeting title>: <date, time>
**Goal**: what a good outcome looks like for the user, in one sentence.
**Who**: one line per attendee (role, relationship, last interaction).
**Context**: 3 to 5 bullets (history, open topics, commitments made last time).
**Questions to ask**: 3 to 5.
**Watch out**: risks, sensitive points, decisions pending.
**Proposed agenda**: 3 to 4 timed items.
```

## 4. After

Offer to create the meeting note with `vault_write` (e.g. `Meetings/YYYY-MM-DD <title>.md`, or the folder their profile mentions) containing the prep and an empty "Notes / Decisions / Next steps" section. Without vault tools, give the prep in the chat only.
