---
date: 2026-06-23
type: brainstorm
status: decided
decision: Option A — MCP-only, deprecate Web UI
audience: 5 ops engineers, Claude Team subscription đã có
---

# Onelog — Quyết định channel: MCP-only, deprecate Web UI

## Context

- Onelog (RAG over VictoriaLogs) hiện có 2 channel:
  - **Web UI** (Next.js + agent FastAPI + Anthropic API key server-side) — đã build xong
  - **MCP** (mcp-semantic Python + mcp-vl official Go) — MVP scaffolded phase-08
- Audience target: **5 ops engineer nội bộ**
- Subscription: **Claude Team** (5 seats riêng) đã có
- Không có user non-tech, không demo khách ngoài

## Problem

Có nên duy trì cả 2 channel? Cost trùng lặp:
- Web UI: Anthropic API per-token (server trả)
- Claude Team: subscription month flat (đã trả rồi)
→ 2 lần trả tiền cho cùng inference.

## Options đã đánh giá

### A. MCP-only + VMUI link (RECOMMENDED)
- Bỏ web + agent service
- 5 ops dùng Claude Desktop, MCP server expose 2 tool: `query` (LogsQL), `search_log_templates` (semantic)
- VMUI link bookmark cho ai cần raw log
- Knowledge sharing: **Claude Team Projects**

**Pros:**
- Cost LLM = $0 (đã có Team)
- Bỏ 2 service maintain (web, agent)
- Inference quota = subscription Team, không pay-per-token
- Native UX trong IDE workflow của ops
- Knowledge sharing **built-in** qua Claude Team Projects

**Cons:**
- Setup MCP per-machine (10 phút × 5)
- Mất citation→VMUI 1-click (mitigate: MCP tool format URL clickable)
- Không có mobile (5 ops chủ yếu laptop, on-call fallback VMUI direct)

### B. Web UI giữ nguyên
**Pros:** UX integrate sẵn, citation→VMUI, mobile OK
**Cons:** Pay 2 lần (Team + API), maintain 3 service, code Next.js 3K+ LOC

### C. Web UI + OAuth Claude Team
**KHÔNG KHẢ THI.** Anthropic phân biệt:
- Claude consumer (Pro/Team) — qua claude.ai/Desktop, **không** expose API
- Anthropic API platform — pay-per-token, **billing tách bạch**
→ Không có OAuth public cho 3rd party app dùng subscription. Dead-end.

### D. Hybrid (giữ cả Web + MCP)
**Cons:** Worst of both — vẫn pay API cho Web + maintain 2 frontend + user confusion (dùng channel nào?). Bị loại.

## Decision

**Option A — MCP-only, deprecate Web UI** (giữ code branch `legacy-web` phòng rollback)

### Lý do quyết định

| Tiêu chí | A | B |
|---|---|---|
| Cost LLM/tháng | **$0** | ~$50-300 trùng lặp |
| Service maintain | 5 service | 8 service |
| Code maintain | ~200 LOC MCP | + 3K LOC Web Next.js |
| Setup user | 10 phút × 5 (1 lần) | 0 |
| Citation→VMUI | URL clickable trong reply | Tích hợp UI |
| Knowledge sharing | **Claude Team Projects native** | List sidebar tự build |
| Mobile | Không | Có |
| Audience fit | 100% ops dev | Phù hợp non-tech (không cần ở đây) |

→ A win 6/8 tiêu chí. 2 điểm thua không critical với 5 ops.

## Knowledge sharing — Claude Team Projects

**Misconception cần fix:** Claude Team ≠ "1 account chia 5 người" (sai, vi phạm ToS). Đúng là **5 seat riêng** trong 1 workspace, conversation isolated by default.

**Cơ chế share đúng:**
- Tạo Project `onelog-investigations` trong workspace
- Invite 5 member → mọi conversation trong Project = visible cho tất cả
- Project system prompt: định hướng dùng tool MCP (vd "luôn `search_log_templates` trước `query`")
- Search built-in để member 2 tìm investigation cũ của member 1

**Discipline duy nhất:** investigation log = conversation **trong Project**, không phải personal chat ngoài.

→ Effort setup: 15 phút. Không code thêm gì.

## Lộ trình deprecate Web UI (1-2 tuần)

### Week 1 — chuẩn bị MCP production

| # | Task | Effort |
|---|---|---|
| 1 | Fix mcp-vl image (build từ source GitHub Go repo, pin version) | 0.5d |
| 2 | mcp-semantic: bỏ profile `mcp` opt-in, đưa vào prod compose | 0.2d |
| 3 | Caddy: route `/mcp/vl/*` + `/mcp/semantic/*` + IP whitelist office/VPN | 0.3d |
| 4 | Token Bearer simple: 5 token hardcode trong `.env` (skip Postgres api_tokens table — overkill cho 5 user) | 0.2d |
| 5 | Audit log: append file `/var/log/onelog-audit/mcp-*.log`, fields: timestamp, user (từ token), tool, query, status | 0.5d |
| 6 | Tool response: format VMUI URL clickable (`https://vmui.internal/?q=...&t=...`) trong mọi hit | 0.3d |

### Week 2 — onboard + deprecate

| # | Task | Effort |
|---|---|---|
| 7 | Doc `docs/mcp-setup-guide.md` cho 5 ops (claude_desktop_config.json, npx mcp-remote, 1 trang + screenshot) | 0.3d |
| 8 | Admin tạo Claude Team Project "onelog-investigations" + invite 5 member + set system prompt | 0.1d |
| 9 | Onboard 5 user: 30 phút meeting + paste config, smoke test | 0.5d |
| 10 | Branch `legacy-web` checkout từ current → remove `web/` + `agent/` services từ docker-compose prod | 0.3d |
| 11 | Decommission: stop containers `ragstack-web` + `ragstack-agent`, free port 3000/8080, remove `ANTHROPIC_API_KEY` server-side | 0.2d |
| 12 | VMUI bookmark + hosts file note trong onboarding doc | 0.1d |

**Tổng:** ~3.5 ngày-người. Payoff vs maintain Web UI dài hạn = **<1 tháng**.

## Risks + mitigation

| Risk | Mức | Mitigation |
|---|---|---|
| Claude Team Projects feature bị deprecate | Thấp | Có thể migrate sang Notion/Confluence sau, không vendor-lock cứng |
| 1 ops rời team → token leak | Trung | Token hardcode `.env` → restart MCP container = revoke. Cho 5 user OK; >10 user mới cần UI |
| MCP spec đổi (SSE → Streamable HTTP) | Thấp | Pin version mcp-victorialogs, monitor release notes |
| Member quên dùng Project → chat personal → mất knowledge | Trung | Quy ước team + Project là default. Onboarding emphasize |
| Cần demo khách hoặc thêm non-tech user | Thấp (chưa có signal) | `git checkout legacy-web` resurrect Web UI. Not one-way door |
| Outbound cost LLM tăng do Project share context dài | Trung | Claude Team có quota cap workspace; Anthropic Projects auto-summarize old conversation |

## Success criteria

- [ ] 5 ops dùng được MCP từ Claude Desktop, smoke test pass (gọi `query` + `search_log_templates` thấy data redact)
- [ ] Project `onelog-investigations` có ≥10 conversation sau 2 tuần
- [ ] Web + agent service stopped, không bill Anthropic API thêm token sau cut-over
- [ ] Audit log MCP capture đủ 5 user identity
- [ ] Sau 1 tháng: ≥3 case member 2 reuse investigation member 1 (verify Project sharing có work)

## Decision tree nếu phát sinh

```
Sau 1 tháng MCP-only:
├── Knowledge sharing OK? (Project work, ≥3 case reuse)
│   ├── Yes → giữ Option A
│   └── No → tier-up: build MCP tool `search_past_incidents` + Postgres
├── Audience mở rộng (thêm non-tech)?
│   ├── Yes → resurrect Web UI từ branch legacy-web
│   └── No → giữ Option A
└── Anthropic price/policy đổi?
    └── Re-evaluate cost model
```

## Next steps

1. Confirm subscription thực tế là **Claude.ai Team** (web, có Projects) — không phải Claude Code CLI Team (chỉ billing seats)
2. Tạo plan dir `plans/260623-XXXX-mcp-only-rollout/` với phase 01-02 theo lộ trình trên
3. Branch `legacy-web` từ current master trước khi remove web/agent service

## Open questions

- Subscription cụ thể là Claude.ai Team hay Claude Code Team? (impact Projects availability)
- MCP config có propagate qua Project không, hay vẫn per-machine? (verify thực tế)
- Audit log cần retention bao lâu? (compliance internal)
- Có cần deprecate alertmanager Web notification path? (vmalert→Telegram đã đủ chưa)
- Document version policy cho mcp-victorialogs image — process upgrade thế nào?
