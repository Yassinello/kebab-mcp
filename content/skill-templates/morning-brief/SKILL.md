---
name: morning-brief
description: >-
  Use when the user starts their day or asks for a morning brief, a daily plan,
  "what's on today", "what should I focus on" or a catch-up on what happened recently.
  Builds a short brief from their profile, today's calendar and recent email (when
  those tools exist) and their recent notes, ending with the top priorities for the day.
metadata:
  title: Morning brief
  icon: "☀️"
  tags: [rituals]
---

# Morning brief

Give the user a brief they can read in under two minutes, then help them commit to a plan.

## Gather (skip any source whose tool is not available, and keep going)

1. **Who and what matters**: call `my_context` for role, active projects, priorities and working hours.
2. **Today's agenda**: if a calendar tool is available in this client, list today's events (times in the user's time zone).
3. **What needs an answer**: if an email tool is available, look at unread or flagged messages from the last 24 hours (72 hours on Monday). Only surface the ones that need the user.
4. **Recent notes**: `vault_recent` (about 10 notes from the last 2 days), then `vault_read` only the ones that look relevant to today. If notes have due or resurface dates, mention those that are due.

## Write the brief

```
## Good morning: <weekday, date>

**Today**: the meetings that matter, with times. Flag conflicts and back-to-back stretches.
**Needs you**: at most 5 emails or open loops, one line each, with the action expected.
**Top 3**: the three things that would make today a success, tied to the priorities from the profile.
**Heads-up**: deadlines, prep needed for a meeting, anything that slipped.
```

- Be concrete and short. No filler, no motivational lines.
- Do not invent events or emails. If a source was unavailable, add one line at the end, e.g. "No calendar connected: agenda not included."
- Finish by asking whether to adjust the Top 3. If the user confirms a plan and vault tools exist, offer to append it to today's note (`Journal/YYYY-MM-DD.md` or the folder their profile mentions) with `vault_append`, creating it with `vault_write` if needed.
