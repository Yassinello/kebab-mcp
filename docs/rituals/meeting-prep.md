# Meeting prep

**Say:** “prep my meeting with Claire”, “what do I need to know for my 3pm?”.

**What it does:** finds the meeting (calendar if available, otherwise one question), then gathers your goals from the profile, past notes on each attendee and the topic (`vault_search`, `vault_read`), and recent email threads when a mail connector exists. It never guesses facts about people.

The result is one page: **Goal**, **Who**, **Context**, **Questions to ask**, **Watch out**, **Proposed agenda**. It then offers to create the meeting note (`Meetings/YYYY-MM-DD <title>.md`) with an empty “Notes / Decisions / Next steps” section.

**Needs:** the profile and the vault. Calendar and mail are optional.

**Template:** [`content/skill-templates/meeting-prep/SKILL.md`](../../content/skill-templates/meeting-prep/SKILL.md)
