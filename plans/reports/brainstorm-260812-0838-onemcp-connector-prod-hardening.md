# Brainstorm — OneMCP Connector prod-hardening

**Date:** 2026-08-12 08:38 · **Scope:** post-ship audit + 3-phase improvement · **Approved by user:** yes

## 1. Problem

Sau khi ship AI Connector v2 (2026-08-11) + 2 bug fix hôm nay (Bearer `departmentId=0`, semantic mode empty fallback), OneMCP Connector đã pass smoke test cho use case hẹp (team KT, Claude Desktop local). Audit tổng thể phát hiện các gap cần cook để đảm bảo correctness + reliability lâu dài — **KHÔNG** bao gồm external client expansion (skip Cloudflare Tunnel per user directive).

## 2. Trạng thái hiện tại (verified 08:38)

- 9/9 containers up (7 healthy)
- 13 OAuth clients registered · 6 users · 12 published artifacts · 12 embeddings · 291 audit events
- OAuth 2.1 AS + DCR + PKCE work
- 8 MCP tools accessible qua Bearer
- Trust-header internal (OpenWebUI) work qua eth1

## 3. Gap triage (YAGNI-filtered)

### MUST cook

| # | Gap | Vì sao cần | Effort |
|---|---|---|---|
| P1 | Wire TEI embedding provider vào SearchService | Tool schema advertise mode=semantic → LLM expect work → thực tế fallback FTS (fake). 12 embeddings idle. False advertising. | 1-2h |
| P2 | E2E smoke test + refresh token verify | Hôm nay lose 2h debug 2 bug. Không test → sẽ lose thêm. Gộp refresh token rotation verify (chưa smoke test per memory). | 2-3h |
| P3 | DCR dedup mở rộng + TTL cleanup cron | Dedup hiện 60s window quá hẹp → Claude Desktop wipe cache → tạo client mới mỗi lần. 13 clients giờ, sẽ 100+ sau vài tháng. Preventive. | 2-3h |

### SKIP (YAGNI)

- **M2 cert auto renew** — Feb 2027 còn 5 tháng, đã có runbook
- **M3 trust-header HMAC** — internal eth1 network + ACL đủ defense
- **L1 Prometheus alerts wire** — team chưa có Alertmanager oncall
- **L2 rate limit per-user** — 6 user, chưa spam
- **L4 non-tech onboarding doc** — chưa có audience

## 4. Chosen solution — 3-phase plan

**Phase 1 — TEI embedding provider wiring** (~1-2h)
- Inject `EmbeddingProvider` (TEI HTTP client) vào `SearchModule` DI
- Verify `runVectorQuery` execute path
- Test: search "nginx" mode=semantic → return vector hits (không phải FTS fallback)

**Phase 2 — E2E smoke test suite** (~2-3h)
- Script bash/python chạy sau mỗi deploy:
  1. DCR register → check dedup
  2. OAuth flow (register → authorize → token exchange) — headless
  3. tools/list → 8 tools
  4. tools/call search "nginx" → ≥ 1 hit
  5. tools/call submit_artifact → verify DB write
  6. Refresh token rotation → old token revoked, new token work
- Cron: chạy sau `docker compose up -d backend`
- Fail alert: log to file, exit code non-zero

**Phase 3 — DCR dedup + TTL cleanup** (~2-3h)
- Backend `oauth.service.ts`: dedup logic bỏ time-window, so sánh (client_name + sorted redirect_uris + auth_method) — reuse existing nếu match
- Migration: mark `last_used_at TIMESTAMPTZ` column trên `oauth_clients`
- Middleware/service update `last_used_at` on each Bearer verify (chỉ set nếu > 1h since last update để tránh write spam)
- Cron job (backend scheduler): xoá clients có `last_used_at < NOW() - 30 days` AND no active tokens

## 5. Success metrics

- **P1:** semantic search khác FTS (verify khác thứ tự / khác hit set)
- **P2:** smoke test chạy pass 6/6 scenarios sau deploy; catch được ít nhất 1 regression future
- **P3:** DCR call thứ 2 cùng client trả cùng `client_id`; `oauth_clients` count không grow > 20 sau 1 tháng dùng

## 6. Risks

- **P1:** TEI trả embedding sai dim → SQL vector cast fail. Mitigation: verify `EMBEDDING_DIM=384` match backend expected
- **P2:** OAuth flow test cần simulate browser callback → dùng cookie jar + follow-redirect. Complexity: 30p extra
- **P3:** Xoá inactive client có thể invalidate token chưa expire → grace period 30 ngày đã handle

## 7. Next steps

- Invoke `/ck:plan` để tạo detailed phase files trong `plans/260812-0838-onemcp-connector-prod-hardening/`
- Cook lần lượt P1 → P2 → P3 (P2 verify P1 + P3 changes)

## Unresolved

- TEI model version match với embeddings đã seed? (Nếu khác model → semantic hits kém). Cần verify trước khi wire.
- Cron scheduler backend đã có sẵn hay cần setup? (Nếu chưa có, phase 3 phải bootstrap thêm — thêm ~1h)
