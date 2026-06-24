# Pre-production gap analysis — MCP-only rollout (Phase 02)

**Date:** 2026-06-24 | **Phase:** 02 Onboard ops + deprecate Web/agent | **Status:** ~70% ready, key blockers identified

---

## 1. Verified working (E2E confirmed 2026-06-24)

- ✅ Claude Desktop ↔ mcp-remote SSE tunnel established on plain HTTP (--allow-http flag required)
- ✅ mcp-vl + mcp-semantic both respond to Bearer token (forward_auth passes X-Mcp-User to audit)
- ✅ VMUI URL format working: time picker now uses `g0.relative_time/range_input/end_input` (was broken)
- ✅ SSE callback (`/message*` route) working for mcp-victorialogs session management
- ✅ WWW-Authenticate Bearer header present; blocks mcp-remote OAuth fallback crash
- ✅ Real query validated: "tìm error mock-mysql 24h" → 3,859 logs clustered to 1 template (error 28 disk full)
- ✅ Audit log JSON Lines format capturing user_id + tool + status (auth.allow/deny recorded)
- ✅ Docker compose decommission syntax correct: web/agent commented, not deleted; ports 3000/8080 freed
- ✅ Caddy clean /.well-known JSON 404 prevents HTML parsing in mcp-remote
- ✅ Branch `legacy-web` pushed to remote (checkpoint @ b343028)

---

## 2. Server-side actions blocking production

**MUST execute on logserver-01 before "in prod" declaration:**

- [ ] **Generate 5 real MCP tokens** (`infra/scripts/gen-mcp-tokens.sh`) — one Bearer per ops, format `sk-mcp-*`
- [ ] **Distribute tokens privately** — email/password manager, NOT Slack/chat (rotation policy TBD)
- [ ] **Apply logserver decommission** (only if web/agent containers running):
  - `docker compose stop web agent && docker compose rm web agent`
  - Delete port bindings 3000/8080 (verify free via `netstat`)
- [ ] **Rotate Anthropic API key** (decommission triggers rotation policy):
  - Remove `ANTHROPIC_API_KEY` from prod `.env`
  - Generate new key via Anthropic admin
  - Verify no cross-service dependency on old key
- [ ] **Update prod `.env`** with 5 ops tokens:
  - Set `MCP_BEARER_TOKENS=user1:sk-xxx,user2:sk-yyy,...`
  - Unset `ANTHROPIC_API_KEY`, `LLM_MOCK` (server-side LLM removed)
  - Restart mcp-semantic: `docker compose restart mcp-semantic`

---

## 3. Process/people blockers (unresolved)

- [ ] **Project creation** — ops lead (user) must create Claude Team Project `onelog-investigations` + invite 5 members via claude.ai UI (not yet automated)
- [ ] **Onboarding meeting** (30 min, 5 ops + lead):
  - Demo Project workflow + system prompt
  - Distribute tokens, ops paste config into Claude Desktop locally
  - Smoke test: 1 semantic query + 1 LogsQL query in Project
  - Set naming convention expectation: `[YYYY-MM-DD] <service> - <symptom>`
- [ ] **No scheduled date yet** — kickoff depends on user readiness (token gen, Project setup, meeting schedule)

---

## 4. Code/config risks discovered (non-blocking, revisit during soak)

**Unresolved follow-ups from Phase 01:**

- `/healthz` endpoint still gated by forward_auth → production k8s/lb probes will fail 401. Workaround: direct port access. Fix = Caddy `handle /mcp/semantic/healthz` BEFORE auth block (polish task, defer post-soak).
- mcp-vl `documentation` tool — Phase 01 plan claimed "disabled" but no evidence in audit/config. Verify actual state during first ops usage; if exposed, add `MCP_DISABLED_TOOLS=documentation` to mcp-vl env.

**Audit/compliance edge cases:**

- Audit log retention policy **undefined** — Phase 02 states "≥90 days" but no automated rotation/archival script. Risk: disk fill if volume small. Mitigation: add logrotate cron to infra/scripts/ (pre-soak).
- PostgreSQL schema retention stated as "≥6 months" but no enforcement (e.g., legal hold trigger). Ops must manually track deletion date or add calendar reminder.
- Session token rotation not documented — if ops lose device/token, manual rotation process TBD (add to ops runbook).

**HTTPS migration:**

- Caddyfile currently `auto_https off` + LAN only (:80). Plan does not specify trigger for HTTPS + real domain. Risk: if onelog scales beyond VPN, will need Let's Encrypt or internal CA (Phase 04+).

---

## 5. Resurrect path verification status

**Current state:** drill script `infra/scripts/resurrect-drill.sh` exists (0.3d effort documented), but **NOT YET EXECUTED**.

- ❌ No `infra/RESURRECT-NOTES.md` file yet
- ❌ Time-to-bootable not measured (target <30 min mock LLM)
- ⚠️ **Risk:** if lockfiles stale on `legacy-web`, drill will fail → cascades to Phase 03 decision paralysis

**Unblock path:** Post-onboarding meeting (Step 4), before Step 5 decommission:
1. SSH into sandbox / fresh VM
2. `REPO_DIR=/tmp/onelog-drill BRANCH=legacy-web ./resurrect-drill.sh`
3. Confirm <30 min, log findings to `infra/RESURRECT-NOTES.md`
4. If drill fails: pin lockfiles on `legacy-web` commit, re-run

---

## 6. Unresolved questions

1. **Project per-machine vs per-workspace?** — Phase 02 step 2 assumes 1 Project `onelog-investigations` shared by 5 ops. Verify Claude Desktop can access workspace Projects (may require re-login after config change).

2. **MCP token distribution chain?** — Current plan says "admin cấp token qua kênh private" but no automation. How often rotate? Who regenerates if ops leaves?

3. **Soak success criteria soft?** — Phase 03 decision matrix lists "Adoption ≥4/5 ops active" but no definition of "active" (daily? weekly?). Need quant threshold before soak starts.

4. **Duplicate investigation threshold?** — Tier 3 triggers at >5/month. Is this baseline expected or best-case? If duplicate rate high, blame = Claude team-search limitation or ops discipline?

5. **Non-tech user access post-launch?** — Plan gates this to Phase 03, but what if PM/support ask within Week 1? Fallback = deny + document or quick Web resurrect?

---

## Summary

**Production readiness:** 70% — server setup complete, E2E verified, but onboarding process incomplete.

**Blockers to remove before Step 4 (onboarding meeting):**
1. Gen 5 real tokens
2. Confirm Project creation / invite (user action)
3. Schedule meeting + 30min block
4. Execute resurrect drill on sandbox (measure time, fix stale deps if found)

**Timeline assumption:** If user completes blockers by 2026-06-27, Phase 02 soak can begin 2026-06-28 (1 week = decision data by 2026-07-05).

**No showstoppers found.** Plan is sound; execution depends on ops team coordination + drill validation.
