# Phase 03 — Review checkpoint 1-2 tháng (hybrid safety net)

## Context
- Plan: [plan.md](plan.md)
- Phase trước: [phase-02-onboard-and-deprecate-web.md](phase-02-onboard-and-deprecate-web.md)
- Decision báo cáo: [brainstorm-260623-1644-ops-mcp-only-decision](../reports/brainstorm-260623-1644-ops-mcp-only-decision.md)

## Overview
- Priority: P1 (scheduled trigger date sau 4-8 tuần Phase 02 hoàn tất)
- Status: scheduled
- Effort: 0.5 ngày-người (data collection + decision meeting)
- Mục tiêu: dựa trên data thật từ 1-2 tháng vận hành MCP-only, quyết định giữ MCP-only hay resurrect Web UI (với LLM key thật). **Không** quyết định trước theo intuition.

## Trigger
Chạy phase này khi: **2026-08-01** (≈ 1 tháng sau onboarding) hoặc **2026-08-31** (≈ 2 tháng), tùy signal sớm/muộn xuất hiện.

## Data cần thu thập trước decision

### 1. Adoption metrics (từ audit log MCP)
- [ ] Số ops active/tuần (gọi ≥1 tool MCP)
- [ ] Tổng tool call/tháng, breakdown theo user
- [ ] Tool nào dùng nhiều nhất (search_log_templates vs query LogsQL)
- [ ] Có user nào "tịt" không dùng → tìm hiểu lý do (UX issue? Workflow mismatch?)

### 2. Knowledge sharing metrics (từ Claude Team Project)
- [ ] Số conversation/tháng trong Project `onelog-investigations`
- [ ] % conversation tạo trong Project vs personal chat (sample 10 ops conversation hỏi)
- [ ] Duplicate investigation rate: count case "member 2 hỏi lại case đã có trong Project"
  - Target: <2/tháng = OK
  - 2-5/tháng = trigger Tier 2 (runbook git habit)
  - >5/tháng = trigger Tier 3 (build search_past_incidents MCP tool)

### 3. Pain point qualitative (1-on-1 5 phút × 5 ops)
- [ ] Câu hỏi: "Trong 1 tháng qua, có lúc nào muốn dùng Web UI thay vì Claude Desktop không?"
- [ ] Câu hỏi: "Có ai non-tech (PM, support) hỏi xin access onelog không?"
- [ ] Câu hỏi: "Có incident mobile nào phải fallback VMUI trực tiếp không?"
- [ ] Câu hỏi: "Setup MCP có gặp issue gì không (Claude Desktop update, token rotate)?"

### 4. Cost metrics
- [ ] Claude Team subscription consumption (Anthropic admin dashboard) — đã hit cap chưa
- [ ] Audit storage size / tháng
- [ ] Server resource (CPU/RAM mcp-vl + mcp-semantic) — load OK?

### 5. Audience signal
- [ ] Có request thêm user từ team khác không? (sales, biz, manager)
- [ ] Có khách hàng / sếp request demo onelog UI không?
- [ ] Có nhu cầu embed log search vào portal nội bộ khác không?

## Decision matrix

| Signal | Action |
|---|---|
| Adoption ≥4/5 ops active + duplicate <2/tháng + 0 non-tech request | ✅ **Giữ MCP-only**. Xóa folder `web/` `agent/` khỏi master, giữ `legacy-web` branch thêm 3 tháng |
| Adoption ≥4/5 + duplicate 2-5/tháng | ⚠️ **Giữ MCP-only + thêm Tier 2** (runbook git habit, weekly review) |
| Adoption ≥4/5 + duplicate >5/tháng | 🛠️ **Giữ MCP-only + build Tier 3** (`search_past_incidents` MCP tool + Postgres incidents table) |
| Adoption <3/5 ops | 🤔 **Investigate root cause**. Có thể UX, workflow, hoặc Claude Desktop hạn chế. Không tự động revert Web |
| ≥3 non-tech user request access | 🔄 **Partial resurrect Web UI** — chạy song song MCP + Web. Web cho non-tech, MCP cho dev |
| Compliance/legal yêu cầu data control | 🔄 **Resurrect Web UI** với LLM API key kiểm soát (Anthropic API + zero-retention contract hoặc OpenAI Enterprise) |
| Mobile incident xảy ra ≥2 lần / tháng | 🔄 **Resurrect Web UI** (responsive layout) hoặc bổ sung Telegram bot chat (lighter alternative) |

## Implementation nếu resurrect Web UI

### Time-to-resurrect realistic (đừng kỳ vọng "ngay")

| Bước | Thời gian | Note |
|---|---|---|
| Checkout `legacy-web` + uncomment compose | 15-30 phút | Mock LLM (LLM_MOCK=true) chạy được luôn |
| Rebuild image nếu deps stale | 30 phút – 2h | Đã pin lockfile ở Phase 02 step 5b, hy vọng không cần |
| Set API key + smoke test 1 query thật | 30 phút | Anthropic/OpenAI key prod |
| **Total quick resurrect (dev-grade)** | **<3h** | Đủ test functional |
| Decide LLM provider + cost cap + monitoring | 1-2 ngày | Sub-phase A |
| Coexist MCP + Web (route, audit merge) | 1 ngày | Sub-phase C |
| **Total production-ready** | **2-4 ngày-người** | Trước khi serve user thật |

Nếu decision = resurrect (any partial/full), spawn plan mới `plans/YYMMDD-XXXX-web-ui-resurrect-with-real-llm/` với scope:

### Phase A — Choose LLM provider (data-driven)
- Đo lại cost thật từ adoption metrics: query/tháng × avg token = monthly bill estimate
- So sánh:
  - Anthropic Sonnet 4.5: best quality, đắt
  - Anthropic Haiku 4.5: cost/quality tốt, recommend default
  - OpenAI GPT-4o-mini: rẻ nhất, quality kém hơn ~15% cho tool-use
- Pick 1 dựa trên budget cap quyết định

### Phase B — Resurrect code
- `git checkout legacy-web` → cherry-pick fix cần (PII, audit, MCP integration mới)
- Update `agent/` để swap provider nếu chọn OpenAI
- Re-enable services `web` + `agent` trong compose
- Add `ANTHROPIC_API_KEY` hoặc `OPENAI_API_KEY` vào prod env
- Cost cap: monthly budget alert + per-user token bucket

### Phase C — Coexist với MCP
- Web UI + MCP cùng tồn tại, audience chia:
  - Web UI = non-tech / mobile / external user
  - MCP = dev ops (giữ workflow đã quen)
- Audit log merge từ 2 nguồn (Postgres web + JSONL MCP)

## Output Phase 03

1. Retro report `plans/reports/retro-{date}-mcp-only-month1.md` với data thu thập
2. Decision document (1 trang) — chốt giữ hay resurrect, lý do
3. Nếu resurrect → spawn plan mới (link từ decision doc)
4. Nếu giữ MCP-only → update plan này status: `completed` + journal entry

## Todo
- [ ] Schedule Phase 03 trigger date (calendar reminder 2026-08-01)
- [ ] Pre-build script `infra/scripts/collect-mcp-metrics.sh` parse audit log → stats
- [ ] Template 1-on-1 questionnaire 5 câu cho ops
- [ ] Setup Anthropic admin dashboard quota alert (>80% subscription cap)
- [ ] Run data collection + 1-on-1 ở trigger date
- [ ] Apply decision matrix → quyết định
- [ ] Document quyết định + execute follow-up

## Success criteria
- Data collected theo đủ 5 nhóm metrics (adoption, sharing, qualitative, cost, audience)
- Quyết định **based on data**, không intuition
- Nếu resurrect: branch `legacy-web` checkout < 30 phút, không vướng git history
- Retro doc rõ ràng cho future reference

## Risks
- Trigger date bị quên → calendar reminder + Anthropic quota alert là backup
- Data collection script chưa làm trước → effort tăng từ 0.5d lên 1d. Make ahead trong Phase 02 hoặc đầu Phase 03
- Resurrect Web sau 2 tháng: dependency npm/docker bị stale → có thể cần rebuild base image. Plan cherry-pick fix.

## Next
- Tùy decision → archive plan hoặc spawn resurrect plan mới
