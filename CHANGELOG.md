# Changelog

All notable changes to MyMCP.
## [0.2.1] - 2026-04-12

### Documentation

- Update CHANGELOG for v0.2.0

### Fixed

- CLI installer — Windows path handling, quotes, empty dir check, Composio pack, tool counts
- CLI UX overhaul + migrate composio-core to @composio/core v0.2.1

## [0.2.0] - 2026-04-11

### Added

- Slack thread/profile, Notion update/query, Composio pack — 51 tools / 7 packs v0.2.0

### Documentation

- Update CHANGELOG for v0.1.2
- Clarify no folder needed before running installer

### Fixed

- Option 1 now shows npx command explicitly

## [0.1.2] - 2026-04-11

### Added

- Create-mymcp CLI installer, GitHub template, pedagogical README v0.1.2

### Documentation

- Update CHANGELOG for v0.1.1

## [0.1.1] - 2026-04-10

### Added

- Add gmail_inbox and calendar_events tools
- Add browser tools (web_browse, web_extract, web_act, linkedin_feed) via Stagehand/Browserbase
- Registry foundation — pack-based tool loading from manifests
- Private status dashboard + admin API
- Guided setup page + Google OAuth flow
- Code quality + diagnostics + docs overhaul
- CI/CD, diagnostics, config export, IPv6 SSRF, repo rename
- Analytics, error webhooks, cron health, packs page, deprecation system
- ESLint + Prettier + Husky, E2E test, Tool Playground
- Slack + Notion packs, Docker support, auto-changelog
- Tailwind UI redesign, security fixes, tests, Docker compose, v0.1.1

### Changed

- Reorganize tools into packs + depersonalize

### Documentation

- Initialize project
- Complete project research (stack, features, architecture, pitfalls, summary)
- Define v1 requirements
- Create roadmap (3 phases)
- Start milestone v1.0 Open Source Framework
- Define milestone v1.0 requirements
- Create milestone v1.0 roadmap (5 phases)
- Packaging — README, .env.example, LICENSE, CONTRIBUTING, CHANGELOG
- README overhaul — architecture diagram, structured tool tables, full endpoint reference

### Fixed

- Add missing vault tools and updated lib files
- Critical code review fixes before open-source release
- Remove last any type in gmail search
- Cron to daily (Vercel free tier limit)
- Revert MCP SDK to ^1.26.0 (compat with mcp-handler 1.1.0)
- Code review — prettier formatting, update docs to 45 tools / 6 packs

### Maintenance

- Add project config

### V2.0

- Add vault_delete, vault_move, save_article + logging, auth, rate limiting, health check

### V3.0

- Complete audit fixes + admin UI redesign

### V3.1

- Add multi-client connection guide to dashboard

