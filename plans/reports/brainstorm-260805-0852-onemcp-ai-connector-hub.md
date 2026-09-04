---
type: brainstorm
date: 2026-08-05
slug: onemcp-ai-connector-hub
owner: trihd@inet.vn
status: agreed
tags: [onemcp, ai-connector, oauth2.1, mcp, skills-registry, claude-desktop, gateway]
relatedPlans:
  - plans/260727-0843-onemcp-gitlab-sso  # foundation — MUST ship first
  - plans/260724-0821-onemcp-multidept-v1-5
  - plans/260730-0843-onemcp-devproduct-pilot
---

# Brainstorm — OneMCP AI Connector Hub

## Problem statement
OneMCP hiện là MCP server monolith (8 tool hard-coded, 1 skills repo, auth CIDR + trust header). Không thể cắm vào Claude Desktop / ChatGPT / Cursor qua remote MCP Connector. Mục tiêu tối thượng: **"sau các dự án đều đẩy skills, MCP lên"** — biến OneMCP thành hạ tầng AI dùng chung của phòng KT.

## Vai trò của OneMCP (đã chốt)
**AI Gateway của phòng KT** — 1 domain, 1 tài khoản SSO, expose skills + tools cho AI client bên ngoài.

5 trách nhiệm:
1. Identity Provider / OAuth broker (OAuth 2.1 Authorization Server cho AI client)
2. MCP protocol endpoint (Streamable HTTP)
3. Skills Registry (multi-project git-sync)
4. Governance (RBAC + audit + rate limit)
5. Portal quản trị (onboarding project, review skills)

## Scope quyết định (phase này)
✅ In-scope:
- OAuth 2.1 Authorization Server + DCR cho AI client
- MCP Streamable HTTP transport chuẩn 2025 spec
- `.well-known/oauth-authorization-server` + `oauth-protected-resource` metadata
- Multi-project Skills Registry (mỗi project 1 git repo, sync worker refactor)
- 8 built-in MCP tools giữ nguyên, expose qua Connector
- RBAC 3 lớp: project_scope (public/dept/private) + skill visibility flag + user role
- Portal onboarding wizard: dev đăng ký repo skills, admin duyệt

⏸ DEFERRED (chờ rõ mục tiêu tool sharing):
- MCP Aggregator (downstream MCP server routing)
- Container hosting cho project MCP server
- Tool namespacing prefix (`projectX_tool`)
- Trigger mở lại: ≥2 project confirm cần share tool giữa các phòng

## Đã bàn — 3 luồng workflow

### Luồng A — Dev đăng ký project (one-time)
1. Dev tạo GitLab repo `phong-x/skills` với structure chuẩn
2. Portal OneMCP: Add project → name, git_repo, deploy_token, scope, allowed_users
3. Dept admin duyệt
4. OneMCP: sync worker clone → skills xuất hiện `list_skills` với prefix `phong-x/*`

### Luồng B — User cài Connector (one-time)
1. Claude Desktop: Add Connector `mcp.inet.vn/mcp`
2. Discovery `.well-known/oauth-authorization-server` → biết OAuth endpoints
3. DCR: POST `/oauth/register` → nhận `client_id`
4. Browser: OAuth flow → GitLab SSO (reuse plan-27) → OneMCP consent screen
5. Claude Desktop nhận `access_token`
6. `initialize` MCP → `Mcp-Session-Id` → SSE stream persistent

### Luồng C — Runtime tool call
1. Claude: `tools/list` → OneMCP filter theo user RBAC → return tools user có quyền
2. Claude: `tools/call` → OneMCP verify token, check RBAC, rate limit, execute, audit
3. Response back to Claude

## Skill permission model (chốt cứng — 3 lớp KISS)
```
project_scope: public | dept | private
skill_visibility (manifest): default (inherit) | restricted (explicit allowed_users)
user_role: viewer | contributor | maintainer | dept-admin | super-admin
```
Filter tại `list_skills` + defense-in-depth check ở `load_skill` + audit log mọi load event.
KHÔNG có runtime approval popup, KHÔNG per-skill role matrix DB.

## Quan hệ với plan-27 (gitlab-sso)
**Plan mới KẾ THỪA plan-27, KHÔNG merge.**

| Concern | Plan-27 role | Plan mới role |
|---|---|---|
| OAuth OneMCP đóng vai | Client của GitLab | Authorization Server cho AI client |
| Output | GitLab SSO user identity + Redis session cookie | OAuth 2.1 access token cho AI client |
| Foundation reuse | — | users module, ensureByEmail, Redis infra, public IP pivot |

**Chain:** plan-27 ship trước → plan mới activate với `blockedBy: [260727-0843-onemcp-gitlab-sso]`.

## Path chọn: Path 2 (skills-registry-first)
Từ 3 path trong brainstorm phase discovery:
- Path 1 (Connector-only): quá hẹp — chỉ AI cắm được, chưa đạt mục tiêu "mọi project đẩy lên"
- ✅ **Path 2 (chọn):** Connector + Multi-project Skills Registry — 70% mục tiêu, 4-6 tuần
- Path 3 (Full Hub with MCP Aggregator): DEFERRED — 8-12 tuần, chưa đủ tín hiệu nhu cầu

## Kiến trúc (bird-eye, không aggregator)
```
AI Client (Claude Desktop / ChatGPT / Cursor)
  │ OAuth 2.1 + Streamable HTTP MCP + Bearer
  ▼
OneMCP Gateway (mcp.inet.vn)
  ├─ OAuth 2.1 AS + DCR + consent
  ├─ MCP tools (8 built-in)
  ├─ Skills Registry (multi-source git-sync)
  │    ├─ phong-kt/skills
  │    ├─ phong-x/skills
  │    └─ ...
  └─ RBAC + audit + rate limit
```

## Downstream MCP hosting (nếu mở lại Path 3)
Recommend Option A (container managed by OneMCP): dev push image → portal deploy → OneMCP tự lifecycle. Option B (URL register) làm fallback cho GPU/data-center exception.

## Phases đề xuất (14-18 ngày)
1. **Phase 1**: MCP Streamable HTTP transport upgrade + `.well-known` metadata (2-3 ngày)
2. **Phase 2**: OAuth 2.1 AS + DCR + consent screen (reuse plan-27 GitLab identity) (4-5 ngày)
3. **Phase 3**: Multi-project Skills Registry (schema, git-sync worker refactor, portal wizard) (4-5 ngày)
4. **Phase 4**: RBAC extension per-project + audit + rate limit hardening (2-3 ngày)
5. **Phase 5**: Rollout — staging + Claude Desktop smoke test + docs + pilot 1-2 project (2 ngày)

## Success metrics (đo 2 tuần post-ship)
- ≥1 AI client (Claude Desktop) cắm được OneMCP qua Connector với OAuth flow hoàn chỉnh
- ≥2 project ngoài phong-KT đăng ký skills repo qua portal
- 0 regression 8 built-in tools + bridge (OpenWebUI, Alertmanager)
- p95 latency `tools/list` < 300ms, `tools/call` < 500ms (built-in)
- Audit log 100% coverage tool call + skill load
- Zero credential leak in logs (token, client_secret)

## Risks + mitigation
| Risk | Mitigation |
|---|---|
| OAuth 2.1 DCR spec drift (client SDK diff) | Test matrix: Claude Desktop + ChatGPT + Cursor + `mcp-remote` proxy |
| Streamable HTTP transport bug với SSE reconnect | Reuse tested lib (`@modelcontextprotocol/sdk` transport helper) |
| Skills git-sync race (2 project push cùng lúc) | BullMQ per-project queue, single worker |
| Skill quality spam (project push rác) | Approval workflow: dept-admin duyệt project mới trước khi go-live; monitoring load count/skill |
| Public exposure widening attack surface | Rate limit tighten (đã có từ plan-27), Bearer token TTL 1h + refresh |
| Tool count explosion (context bloat AI) | Lazy load: `tools/list` return tối đa 20, thêm `search_tools` MCP tool cho AI tự query |

## Validation criteria
- Claude Desktop cắm mcp.inet.vn/mcp qua OAuth flow, không dùng workaround token thủ công
- Dev phong-X push skills repo → sau ≤ 5 phút xuất hiện `list_skills` output
- Dept admin flip project scope private→public → user ngoài dept thấy skills sau ≤ 30s cache invalidate
- `curl` với expired token → 401 với `WWW-Authenticate: Bearer error="invalid_token"` chuẩn RFC 6750
- Audit log query: cho tool + skill load trong last 7d, group by user

## Next steps
1. Plan-27 (gitlab-sso) ship trước — Phase 1 blocker: iNET GitLab OAuth app registration
2. Sau plan-27 ship, activate plan mới `260805-0852-onemcp-ai-connector-hub` (status: blocked → pending)
3. Kick research phase 1 (docs-seeker): MCP Streamable HTTP transport spec 2025 + OAuth 2.1 DCR spec RFC 7591

## Unresolved questions
1. **Consent screen scope granularity**: user consent 1 lần cho toàn bộ tools/skills (coarse), hay per-tool checkbox (fine)? Recommend coarse cho v1, fine nếu user request.
2. **Refresh token rotation policy**: rotate mỗi refresh (higher security) hay long-lived (simpler)? Chuẩn OAuth 2.1 recommend rotate — cần confirm client SDK support.
3. **Multi-tenant Skills git repo model**: 1 repo per project (isolation cao, N clone) hay mono-repo có folder per project (đơn giản, dùng chung deploy token)? Recommend 1 repo per project cho long-term flexibility.
4. **Portal wizard UX**: form thẳng hay wizard nhiều bước? Cần UX pass với 1-2 dev pilot trước khi quyết.
5. **Deployment**: cần domain riêng cho MCP endpoint (VD `mcp.inet.vn` tách khỏi portal `onemcp.inet.vn`) hay share subdomain? Reuse public IP pivot của plan-27 (202.92.5.113) có đủ không, hay cần Let's Encrypt + domain thật (Claude Desktop có thể strict về TLS cert)?

**Q5 là câu hỏi có thể block Phase 1** — cần confirm trước khi kick off.
