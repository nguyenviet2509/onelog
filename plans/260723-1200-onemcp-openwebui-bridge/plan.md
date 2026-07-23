---
name: onemcp-openwebui-bridge
title: Bridge OneMCP → OpenWebUI (reuse existing KB infra)
slug: onemcp-openwebui-bridge
date: 2026-07-23
status: pending
owner: trihd@inet.vn
mode: --fast
blockedBy: []
blocks: []
supersedes:
  - plans/260723-1135-mcp-kb-incident-memory
  - plans/260716-1422-chat-conversations-kb-search
relatedReports:
  - plans/reports/brainstorm-260723-1200-onemcp-openwebui-bridge.md
relatedProjects:
  - D:/Vietnt/Project/onemcp
tags: [mcp, kb, openwebui, mcpo, onemcp, integration]
---

# Plan: Bridge OneMCP → OpenWebUI

## Mục tiêu
Không build KB mới. Wire OneMCP (đã có: search/submit_artifact/review/portal/audit/backup/Alertmanager P7) vào OpenWebUI của OneLog để team có "incident memory" ngay. Member A fix xong lỗi → submit vào OneMCP qua chat → Member B hỏi lỗi tương tự → LLM search OneMCP trước → present cached.

## Bối cảnh
- OneMCP primary use case = đúng bài toán này (bug-trace KB reuse). Đã ship P1-P7.
- 2 plan cũ superseded: `260716-1422-chat-conversations-kb-search` (OpenWebUI native KB — không đủ), `260723-1135-mcp-kb-incident-memory` (build mới — duplicate với OneMCP).
- Brainstorm chi tiết: [brainstorm-260723-1200-onemcp-openwebui-bridge.md](../reports/brainstorm-260723-1200-onemcp-openwebui-bridge.md)

## Architecture
```
OpenWebUI ─┬─ Function onemcp-search  (LLM tự gọi, filter status=published)
           │      │
           └─ Action onemcp-submit-kb (user click 📚 nút dưới message → modal)
                  │
                  ▼
             OneMCP /api/mcp  (X-Onemcp-User = real user email)
                  │
                  ├─▶ Postgres + MinIO (existing)
                  └─▶ portal (verify UI, existing)

OneLog Alertmanager ──webhook──▶ OneMCP /api/webhooks/alerts (existing P7)
```

## Design decisions (2026-07-23 13:24)
1. **Search chỉ trả `published`** entries (an toàn, không gợi ý fix chưa verify)
2. **Submit qua nút Action** (user chủ động click) thay vì auto-detect "fixed" — modal preview trong OpenWebUI
3. **Identity passthrough** — `X-Onemcp-User = __user__.email` từ OpenWebUI login → OneMCP audit đúng người
4. **Path**: OpenWebUI Function + Action (bỏ mcpo bridge do cần per-request header)

## Search layer decision
- Chấp nhận **FTS unaccent + trigram** (OneMCP hiện tại) làm layer đầu
- Mitigate synonym-miss bằng: tags convention + LLM sinh multi-query candidate + monitor miss rate
- Threshold escalate: nếu sau 4 tuần miss rate > 40% → mở decision Option B (contribute pgvector P4.2 vào OneMCP)

## Phases

| # | Phase | Status | Effort | File |
|---|-------|--------|--------|------|
| 1 | Compat + network + auth prep | pending | 0.5-1 ngày | [phase-01-compat-network-auth.md](phase-01-compat-network-auth.md) |
| 2 | OpenWebUI Function (search) + Action (submit button) | pending | 1-1.5 ngày | [phase-02-bridge-mechanism.md](phase-02-bridge-mechanism.md) |
| 3 | OpenWebUI system prompt + admin config | pending | 0.5 ngày | [phase-03-system-prompt.md](phase-03-system-prompt.md) |
| 4 | Alertmanager webhook verify | pending | 0.5 ngày | [phase-04-alertmanager-webhook.md](phase-04-alertmanager-webhook.md) |
| 5 | Smoke test end-to-end + docs update | pending | 0.5-1 ngày | [phase-05-smoke-and-docs.md](phase-05-smoke-and-docs.md) |

Tổng: **2-4 ngày**.

## Confirmed constraints (2026-07-23 13:47, network pivot 15:25)
1. **OneMCP host** = VPS lab riêng, IP `192.168.122.56`. Deploy độc lập.
2. **OneMCP endpoint** = `https://192.168.122.56/api/mcp` (qua nginx OneMCP, self-signed cert `onemcp.crt` từ CN=onemcp.local).
3. **[PIVOT] OneLog target = `onelog-source` lab (192.168.122.53)** — cùng subnet với OneMCP, network 21ms. **KHÔNG deploy lên onelog-vps prod** vì onelog-vps (public 202.92.5.112) không route được vào private 192.168.122.x. Prod rollout defer đến khi có VPN/expose OneMCP public. onelog-source = throw-away lab (per `.claude/rules/host-sync-policy.md`), phù hợp MVP validation.
3. **OpenWebUI version** = **0.10.2 (latest)**. Cần verify runtime Action `__event_call__ type:input` (modal preview). Fallback: submit không preview nếu unsupported.
4. **CIDR whitelist** OneMCP đã include IP host chạy OneLog stack (user confirm "tương tự OneLog"). Verify trong Phase 1.
5. **User provisioning** = **bot chung `openwebui-bot`** (đơn giản MVP, attribution = bot). Function không cần identity passthrough — dùng static header.
6. **Seed source** = Claude scan `plans/reports/journal-*` + reports cũ của OneLog → tạo 5-10 draft markdown → user review → publish.

## Success metrics
- Bridge live: OpenWebUI hiển thị tools `search`, `submit_artifact`, `get_artifact` từ OneMCP
- Sau 2 tuần: ≥ 5 chat sessions gọi `search` với hit ≥ 1
- Sau 4 tuần: ≥ 10 published KB entries có nguồn từ OpenWebUI chat
- FTS hit rate ≥ 40% (nếu thấp → decision Option B)

## Out of scope
- pgvector semantic (Option B, defer)
- OneMCP schema changes v1 (chỉ add nếu block hoàn toàn)
- Custom curation UI (dùng portal OneMCP)
- Migrate data từ OpenWebUI native Knowledge cũ (nếu có) — quyết sau

## Validation Log (2026-07-23 14:45 — Session 1)

6 câu hỏi, tất cả accept recommendation:

| # | Decision | Applied to |
|---|---|---|
| V1 | OpenWebUI Action modal `type:input` fail → **STOP + replan** (không proceed Phase 2) | Phase 1 |
| V2 | TLS: **verify TLS + mount OneMCP CA cert** | Phase 1, Phase 2 |
| V3 | Redact: **hard block private key/sk-*, soft redact IPs/emails, BEFORE summarizer** | Phase 2 |
| V4 | Seed **15-25 entries covering 6-8 core services** | Phase 5 |
| V5 | Rollout **staged: admin/tri only tuần 1 → team tuần 2** | Phase 5 |
| V6 | Escalate decision horizon: **4 tuần** (giữ plan) | Phase 5 (unchanged) |

Red Team findings applied qua validation: C1 (V1), C2 (V2), C3 (V3), H4 (V4), M1 (V5). Còn deferred: H1 (CIDR verify — đã trong Phase 1 sub-task), H2 (debounce), H3 (stale prompt), H5 (enforcement metric), M2 (CIDR /32 tighten). Sẽ cân nhắc apply khi cook nếu cost < value.

## Red Team Review (2026-07-23 14:45 — findings deferred, not applied inline)

10 findings từ 3 lens (Security / Assumption / Failure). User chọn không apply inline, chạy validate trước. Findings được lưu ở đây để reference khi cook — cân nhắc từng cái tại thời điểm implement.

**Critical:**
- C1: OpenWebUI Action `__event_call__ type:input` chưa verify → Phase 1 cần hard STOP gate nếu unsupported (fallback: portal redirect)
- C2: `VERIFY_TLS=false` default → LAN không phải trusted zone, mount OneMCP CA cert, default true
- C3: Redact secret trong transcript vague → enumerate patterns + unit test + block submit nếu match high-risk (private key)

**High:**
- H1: CIDR "tương tự OneLog" chưa verify → Phase 1 SSH cat .env verify
- H2: Double-click / summarizer slow → duplicate submit; add debounce + loading state + signature dedup 5min window
- H3: Stale KB (> 90d) trusted mù → prompt tag "verified N ngày trước" khi present
- H4: Seed 5-10 có thể ít → raise 15-25 covering 6-8 core services
- H5: LLM search-first = prompt hope, không đo → weekly parse OneMCP audit log tính enforcement rate

**Medium:**
- M1: Big-bang rollout risky → staged (admin week 1, team week 2)
- M2 (partial): Tighten CIDR whitelist `/32` OneLog host (bỏ phần HMAC over-engineering)

**Deferred/rejected:**
- L1: Portal maintainer bottleneck — cross-team, không actionable trong plan này

## Risks (top 3)
1. **OpenWebUI Action modal API version drift** — verify `__event_call__ type:input` trong Phase 1; fallback submit không preview nếu unsupported
2. **FTS miss synonym queries** — chấp nhận, monitor 4 tuần, escalate nếu > 40% miss
3. **Cold start** — tuần 1-2 chưa có published entries → team không thấy value → seed 5-10 entries manual trước go-live (Phase 5 gate)
