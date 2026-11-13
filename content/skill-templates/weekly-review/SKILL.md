---
name: weekly-review
description: >-
  Use at the end or start of a week, when the user asks for a weekly review, a recap of
  the week, "what did I do this week" or help planning next week. Looks back at the past
  seven days (usage recap, recent notes, calendar when available), compares them with the
  user's priorities, and ends with next week's top priorities and a saved review note.
metadata:
  title: Weekly review
  icon: "🗓️"
  tags: [rituals]
---

# Weekly review

A 10-minute guided review: look back, compare with what matters, decide next week.

## 1. Look back (skip sources that are not available)

- `my_context`: the user's priorities and active projects, the yardstick for the review.
- **Recap**: if a `kebab_weekly_recap` tool is available, call it for the past week and use it as the backbone. Otherwise call `vault_recent` with `since` set to 7 days ago (up to 30 notes), then `vault_read` the notes that matter (meeting notes, journal, project notes).
- If a calendar tool is available: the meetings of the past week and those of next week.
- The previous review, if any (`vault_search` for "Weekly review"): what was planned, to check what happened.

## 2. Write the review

```
## Weekly review: week of <Monday date>
**Done**: what moved forward, grouped by project.
**Not done**: what was planned but did not happen, and why if known.
**Learned**: 1 to 3 insights, decisions or surprises.
**Open loops**: waiting-fors, follow-ups owed, things to drop.
**Next week, top 3**: tied to the profile's priorities, each with a first concrete step.
```

Ask at most two questions to fill gaps (e.g. "anything important that is not in your notes?"). Do not invent progress.

## 3. Save

- If vault tools exist, save the review with `vault_write` (e.g. `Reviews/YYYY-Www.md`, or the folder the profile mentions) and say where.
- If the user's priorities have clearly changed, propose the exact change and apply it with `my_context_update` only after they agree.
- Without vault tools, give the review in the chat and suggest copying it.
