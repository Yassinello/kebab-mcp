# Read later

**Say:** “read later” with a link, “save this”, “what's on my reading list?”, “that article about pricing”.

**What it does:**

- **Save:** calls `save_article` with 2 to 4 tags tied to your projects, then replies with the title, a one-sentence summary and why it matters to you. If you say why you saved it, that sentence goes into the note.
- **Find:** searches your reading folder by topic (`vault_search`) or lists the latest saves (`vault_recent`), and offers to summarize one.

Saved articles are framed as outside content when read back, so instructions hidden in a page are treated as data.

**Needs:** the vault (`save_article` is part of Memory Vault). Without it, the link is summarized in the chat and nothing is claimed as saved.

**Template:** [`content/skill-templates/read-later/SKILL.md`](../../content/skill-templates/read-later/SKILL.md)
