# Changelog

All notable changes to MyMCP will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-04-10

### Added
- Pack-based tool registry with 4 packs: Google Workspace (18 tools), Obsidian Vault (15), Browser Automation (4), Admin (1)
- Dynamic pack activation based on env var presence
- Core framework: types, config, registry, auth separation, logging
- `.env.example` with full documentation
- Deploy to Vercel button
- MIT License

### Changed
- Renamed from YassMCP to MyMCP
- Reorganized from flat `src/tools/` to `src/packs/*/tools/`
- Replaced hardcoded locale/timezone with configurable env vars
- Health endpoint now returns minimal public liveness only
- Auth: added optional ADMIN_AUTH_TOKEN separate from MCP_AUTH_TOKEN

### Removed
- All hardcoded personal references
- Old monolithic route.ts (~350 lines → ~30 lines)
