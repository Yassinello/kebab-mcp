---
name: remember
description: >-
  Use when the user says "remember this", "note that", "don't forget", "keep in mind",
  or shares a lasting fact, preference, decision or idea they want available in future
  conversations. Saves it to their profile (durable facts about them) or to a note
  (everything else), then confirms where it went.
metadata:
  title: Remember
  icon: "🧠"
  tags: [rituals]
---

# Remember

Save something the user wants kept, so every AI client connected to Kebab House can use it later.

## Steps

1. **Pin down what to keep.** Restate it as one short, self-contained sentence (who, what, when). If it is ambiguous, or touches sensitive data (health, money, other people's private details), ask before saving.
2. **Pick the destination.**
   - **Profile**: a lasting fact about the user (preferences, role, projects, people they work with, how they like things done). Call `my_context` first to avoid duplicates or contradictions, then `my_context_update` with `mode: "append"` and a single bullet. Use `mode: "replace"` only when the user explicitly asks to correct or rewrite the profile, and show the new text before applying it.
   - **Note**: everything else (an idea, a decision, a project fact, a link). If a note on that topic exists (`vault_search`), add to it with `vault_append`. Otherwise append a bullet to today's inbox note `Inbox/YYYY-MM-DD.md` with `vault_append`, creating it with `vault_write` if it does not exist yet. Follow any folder conventions found in `my_context`.
3. **Confirm in one line** what was saved and where, e.g. "Added to your profile" or "Added to Inbox/2026-03-14.md".

## If a tool is missing

- No `my_context_update`: save it as a note instead and say so.
- No vault tools: use `my_context_update` if the fact is about the user; otherwise say it could not be saved and give the user the sentence to keep.
- Nothing can save: say so plainly. Never claim something was saved when it was not.
