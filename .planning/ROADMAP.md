# Roadmap: MyMCP v1.0

## Overview

Transform YassMCP (a personal MCP server with 38 hardcoded tools) into MyMCP (a forkable open-source framework). Five phases move from internal architecture (registry + pack manifests) through physical file reorganization, public packaging, a private status dashboard, and finally guided setup with Google OAuth. Each phase delivers a coherent, verifiable capability that unblocks the next.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Registry Foundation** - Core types, config module, pack registry, auth separation, route.ts refactor
- [ ] **Phase 2: Physical Reorganization** - Move files into packs, depersonalize, add manifests, contract tests
- [ ] **Phase 3: Packaging & Documentation** - .env.example, README, deploy button, LICENSE, CONTRIBUTING, health version
- [ ] **Phase 4: Private Status Dashboard** - Auth-gated web UI showing pack status, diagnostics, logs, MCP URL
- [ ] **Phase 5: Guided Setup & OAuth** - Setup checklist, Google OAuth consent flow, per-pack verification

## Phase Details

### Phase 1: Registry Foundation
**Goal**: The MCP server loads tools dynamically from a registry that resolves pack state from env vars, with separated auth for MCP vs admin
**Depends on**: Nothing (first phase)
**Requirements**: REG-01, REG-02, REG-03, REG-04, REG-05, REG-06, REG-07, REG-08, REG-09, REG-10
**Success Criteria** (what must be TRUE):
  1. Core types (PackManifest, ToolDefinition, InstanceConfig) exist and are used by at least one pack manifest
  2. route.ts imports the registry, iterates enabled tools, and registers them via server.tool() -- reduced from ~350 lines to ~30
  3. Removing a required env var causes that pack to skip with a console warning naming the missing vars, not crash
  4. Setting MYMCP_DISABLE_GOOGLE=true prevents Google tools from registering even when credentials are present
  5. npm run dev starts locally with .env file and behaves identically to Vercel deployment
**Plans**: TBD

Plans:
- [ ] 01-01: TBD
- [ ] 01-02: TBD

### Phase 2: Physical Reorganization
**Goal**: Tools and libs physically live in pack directories, all personal references are replaced by config values, and contract tests prove nothing broke
**Depends on**: Phase 1
**Requirements**: REORG-01, REORG-02, REORG-03, REORG-04, REORG-05, REORG-06, REORG-07, REORG-08, REORG-09, REORG-10
**Success Criteria** (what must be TRUE):
  1. Every tool file lives under src/packs/{google,vault,browser,admin}/tools/ and every pack-specific lib lives under src/packs/*/lib/
  2. grep -r "Yassine\|citizenyass\|Europe/Paris" src/ returns zero results -- all personal references use InstanceConfig
  3. Smoke test script starts the dev server, calls tools/list, and verifies tool count matches env var config
  4. Contract snapshot test captures all 38 tool names + input schemas and fails on unexpected changes
  5. npm run build passes with zero TypeScript errors and all imports resolved
**Plans**: TBD

Plans:
- [ ] 02-01: TBD
- [ ] 02-02: TBD

### Phase 3: Packaging & Documentation
**Goal**: A developer can discover MyMCP, understand what it does, and deploy it from the README alone
**Depends on**: Phase 2
**Requirements**: PKG-01, PKG-02, PKG-03, PKG-04, PKG-05, PKG-06, PKG-07, PKG-08
**Success Criteria** (what must be TRUE):
  1. .env.example lists every env var with description, required/optional flag, and URL to obtain the credential
  2. Clicking "Deploy to Vercel" in the README forks the repo, prompts for env vars, and produces a working deployment
  3. README covers: what MyMCP is, tool pack list with tool counts, 5-minute quickstart, and architecture overview
  4. package.json has name "mymcp", MIT license, and repository URL; LICENSE and CONTRIBUTING.md files exist at repo root
**Plans**: TBD

Plans:
- [ ] 03-01: TBD

### Phase 4: Private Status Dashboard
**Goal**: Users can see their instance health, pack status, and recent activity through an auth-gated web UI
**Depends on**: Phase 3
**Requirements**: DASH-01, DASH-02, DASH-03, DASH-04, DASH-05, DASH-06
**Success Criteria** (what must be TRUE):
  1. Visiting / without ADMIN_AUTH_TOKEN returns 401 -- no pack details or tool info leaked
  2. Authenticated dashboard shows each pack as active/inactive with tool count and reason for inactive state (missing env vars listed)
  3. Pack diagnose() runs optional async checks verifying credentials actually work (API call succeeds, not just env var present)
  4. MCP endpoint URL is displayed with a copy button formatted for Claude Desktop JSON config
  5. Recent tool call logs are visible, clearly labeled as ephemeral/best-effort
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD

### Phase 5: Guided Setup & OAuth
**Goal**: Users configure their MyMCP instance through a guided setup flow with built-in Google OAuth, eliminating manual token gymnastics
**Depends on**: Phase 4
**Requirements**: SETUP-01, SETUP-02, SETUP-03, SETUP-04, SETUP-05, SETUP-06, SETUP-07
**Success Criteria** (what must be TRUE):
  1. /setup page shows a checklist per pack with configured/not-configured status reflecting actual env var state
  2. User can complete Google OAuth consent flow entirely within the app -- click "Connect Google", authorize, see refresh token
  3. Refresh token is displayed masked by default, revealable explicitly, and never logged -- with clear instructions to copy to Vercel env vars
  4. Vault and Browser setup sections verify credentials work (GitHub PAT has repo access, Browserbase API key is valid) and show success/failure
  5. Step-by-step documentation exists for creating a personal Google Cloud OAuth app with correct scopes
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Registry Foundation | 0/? | Not started | - |
| 2. Physical Reorganization | 0/? | Not started | - |
| 3. Packaging & Documentation | 0/? | Not started | - |
| 4. Private Status Dashboard | 0/? | Not started | - |
| 5. Guided Setup & OAuth | 0/? | Not started | - |
