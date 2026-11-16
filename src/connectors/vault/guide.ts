/**
 * Credential / setup guide for the vault connector (markdown, shown in
 * /config → Connectors). Kebab House phase 2: the vault works out of the box
 * in the KV store; GitHub (Obsidian) is optional.
 */
export const VAULT_GUIDE = `Read, write, search, and link Markdown notes — your long-term memory, shared by every client.

### Where the notes live
- **KV (default)** — with no GitHub credentials, notes are stored in this instance's KV store (Upstash, or the local file in Docker / dev). Nothing to set up. Limits: 256 KB per note, 5,000 notes; a warning appears above 50 MB in total.
- **GitHub (Obsidian)** — set \`GITHUB_PAT\` and \`GITHUB_REPO\` and the vault is a GitHub repository you can also open in Obsidian. Every write becomes a git commit, so you get full history for free.
- **Explicit choice** — \`KEBAB_VAULT_BACKEND=kv\` or \`KEBAB_VAULT_BACKEND=github\` overrides the detection (for example \`kv\` after importing a GitHub vault, while keeping the token for other uses).

### Move a GitHub vault into the KV
Open this card and click **Import GitHub vault into KV**: Markdown files are copied (other files are skipped, notes over 256 KB are reported as too large). A note that exists in both with different content is kept as it is here, unless you tick **Overwrite notes that exist in both**. The import never switches backend by itself — set \`KEBAB_VAULT_BACKEND=kv\` (or remove the GitHub credentials) when you are ready, then redeploy.

### GitHub credentials (optional)
1. Go to [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens/new) and create a **fine-grained** personal access token
2. Under **Repository access**, pick _Only select repositories_ and choose your vault repo (a **private** repo is recommended; it can start empty)
3. Grant **Contents: Read and write** and **Metadata: Read-only**
4. Copy the token into \`GITHUB_PAT\`
5. Set \`GITHUB_REPO\` to \`owner/repo\` (e.g. \`yassine/my-vault\`)
6. Optional: override the default branch with \`GITHUB_BRANCH\` (defaults to \`main\`)

### Troubleshooting
- _404 on the repo_: the token wasn't granted access to that specific repo — edit it and add it.
- _409 conflict on write_: the note changed between your read and write; read it again and retry with the new \`sha\`.
- _Search returns nothing fresh (GitHub)_: GitHub's search index lags by 1–2 minutes after a commit; that's normal.
- _A note is missing from listings (KV)_: it comes back on its own within a few minutes; to fix it now, click **Rebuild index** on this card. Notes themselves are never lost.`;
