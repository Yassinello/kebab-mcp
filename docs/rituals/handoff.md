# Handoff

**Say:** “hand this off”, “continue this in Cursor”, and later, in the other client: “pick up where I left off”.

**What it does:** moves a conversation from one AI client to another without copy-pasting.

- **Hand off** — writes a short note of where you are: the goal, what is decided, what is open, the next step, and the files, links or names that matter. It is saved as `Handoffs/YYYY-MM-DD <topic>.md`, then the ritual tells you the note's name.
- **Pick up** — in the next client, lists your recent handoff notes, loads the one you choose (the newest by default), and carries on from its next step.

It writes only what the conversation contains; nothing is guessed. Sensitive details (keys, passwords) are left out of the note.

**Needs:** the vault (built in, or your GitHub repository) and a client allowed to write your notes (access level *read + my profile and notes* or *everything*). A client with read-only access can pick up a handoff, not write one.

**Template:** [`content/skill-templates/handoff/SKILL.md`](../../content/skill-templates/handoff/SKILL.md)
