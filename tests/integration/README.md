# Integration tests

These tests live outside the default `npm test` pool because they exercise
cross-process state, network calls, or platform-specific behavior. Run with:

```bash
npx vitest run tests/integration/<file>
```

Or run the whole suite with `npm run test:integration` (if that script exists in package.json).

## Env-gated tests

Some integration tests require external service credentials. They use
`describe.skipIf(...)` so CI passes without the env, but a maintainer
can run them manually.

### tests/integration/config-update-github-live.test.ts (Phase 062 / STAB-03)

Live GitHub Compare API test — proves the corrected URL direction
(BASE=upstream, HEAD=fork) returns the right semantics against real
GitHub. Skipped unless ALL of the required env vars below are set;
the file's `ENABLED` flag is computed from `process.env` and fed into
`describe.skipIf` / `it.skipIf`.

| Env var                    | Required | Description                                                                                |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `GITHUB_TEST_TOKEN`        | Yes      | GitHub PAT with `public_repo` (or `repo` for private forks) scope                          |
| `GITHUB_TEST_FORK_OWNER`   | Yes      | Owner of the fixture forks (e.g., your username)                                           |
| `GITHUB_TEST_FORK_BEHIND`  | Yes      | Fork repo slug that's N commits behind upstream main                                       |
| `GITHUB_TEST_FORK_AHEAD`   | Yes      | Fork repo slug with at least 1 local commit not in upstream                                |
| `GITHUB_TEST_FORK_IDENTICAL` | No     | Fork repo slug that mirrors upstream exactly (the identical-state case skips if unset)     |

#### Quick local recipe

```bash
GITHUB_TEST_TOKEN=ghp_xxx \
GITHUB_TEST_FORK_OWNER=your-username \
GITHUB_TEST_FORK_BEHIND=kebab-mcp-test-behind \
GITHUB_TEST_FORK_AHEAD=kebab-mcp-test-ahead \
GITHUB_TEST_FORK_IDENTICAL=kebab-mcp-test-identical \
npx vitest run tests/integration/config-update-github-live.test.ts
```

#### Fixture setup

Maintain at least two fork repos under your account at known commit
offsets relative to `Yassinello/kebab-mcp:main`:

1. **BEHIND fork** — fork reset to an older commit on `main` (e.g.,
   a tag from v0.10). Compare against upstream MUST return
   `status="behind"` + `behind_by > 0`.
2. **AHEAD fork** — fork with at least one local commit on top of
   upstream `main` (a no-op edit to README.md is enough). MUST
   return `ahead_by >= 1`. If the fork is also behind upstream, the
   compare returns `status="diverged"`; otherwise `"ahead"`.
3. **IDENTICAL fork** *(optional)* — fork mirroring upstream `main`.
   Returns `status="identical"`. If unset, that test case is skipped
   non-fatally.

Re-create offsets when upstream advances:

```bash
git remote add upstream https://github.com/Yassinello/kebab-mcp.git
git fetch upstream
git reset --hard <known-offset-sha>     # for the BEHIND fork
git push --force origin main
```

See the test file's header docstring for the canonical reference.
