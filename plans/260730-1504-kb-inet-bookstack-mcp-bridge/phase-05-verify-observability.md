# Phase 5 — Verify + 2-week observability

**Status:** pending
**Priority:** P1
**Effort:** ~1h setup + 2 tuần chạy
**Depends on:** Phase 4

## Mục tiêu

Xác nhận routing đúng qua 5 test query, thu thập metric 2 tuần để quyết định có cần chuyển sang "proxy trong OneMCP" (cách 3 brainstorm) hay giữ nguyên standalone.

## 5.1 Smoke test 5 query mẫu (day 0)

Chạy trong OpenWebUI chat, ghi kết quả vào `plans/.../notes/smoke-test-day0.md`:

| # | Query | Nguồn kỳ vọng | Pass criteria |
|---|-------|---------------|---------------|
| 1 | "Cách cài OnePanel trên CentOS 7" | KB (search + get_page) | Reply cite `kb.inet.vn`, chỉ gọi bookstack whitelist tools |
| 2 | "Log 502 site X trong 1h qua" | onelog-vl only | Reply có log lines, không gọi bookstack |
| 3 | "502 fleet + runbook xử lý" | KB + onelog-vl, label rõ | Reply có ≥1 nhãn `📘 Runbook (KB)` HOẶC `🔍 Log gần nhất` |
| 4 | "KB có gì mới tuần này" | `bookstack__get_recent_changes` | Reply liệt kê pages mới |
| 5 | "Tìm trong KB xem có tài liệu Jetbackup không" | KB forced | Chỉ gọi bookstack search+get_page |
| 6 | **Diacritic test**: "khắc phục lỗi 502" vs "khac phuc loi 502" | Cả 2 query ra kết quả tương đương (nếu BookStack fold) HOẶC LLM tự thử variant (nếu không fold) | Ít nhất 1 trong 2 câu trả về kết quả KB relevant |
| 7 | **Whitelist test**: "list tất cả books trong KB" | LLM từ chối gọi `get_books` (ngoài whitelist) | Reply nói "không dùng tool đó, dùng search thay thế" |

**Fail bất kỳ query nào → điều chỉnh system prompt phase 4, retest.**

## 5.2 Metrics thu 2 tuần (day 1 → day 14)

Lấy từ OpenWebUI logs + Caddy access log. Có thể query bằng logserver (VictoriaLogs đã có).

| Metric | Target | Nguồn |
|---|---|---|
| % chat có ≥1 tool KB call khi câu hỏi kỹ thuật | ≥60% | OpenWebUI tool log |
| % LLM cite source link trong reply | ≥80% | Manual sample 20 chat/tuần |
| % tool call ngoài whitelist (không phải `search_pages`/`get_page`/`get_recent_changes`) | <10% | OpenWebUI tool log |
| p95 latency `bookstack__search_pages` | <2s | Docker log bookstack-mcp / OpenWebUI tool timing |
| Số lần bookstack-mcp restart / crash | 0 | Docker healthcheck |
| Zero write op từ bot | 0 | BookStack activity log filter user=bot |
| Diacritic miss rate (VN có dấu ra 0 result nhưng bỏ dấu ra kết quả) | <5% queries | Spot check 20 sample |

Setup dashboard đơn giản trong Grafana OneLog (log source: VictoriaLogs, filter container=`bookstack-mcp` + `openwebui`).

## 5.3 Decision gate (end of week 2)

Chạy retro, đánh giá:

| Điều kiện | Hành động |
|---|---|
| Tool bloat >10% call sai whitelist | Escalate → tạo plan follow-up: "OneMCP proxy 3 tool KB" (cách 3 brainstorm) |
| p95 latency >2s | Add cache 60s trong OneMCP proxy (cùng plan follow-up) |
| Keyword search miss nhiều (spot check) | Escalate → plan follow-up: "semantic RAG mirror hot pages" (cách C brainstorm) |
| Tất cả OK | Đóng plan, monitor casual |

## 5.4 Rotation & maintenance

- Set calendar reminder **2027-06-30**: renew BookStack API token trước 30 ngày.
- Update dashboard link vào `docs/onelog-index.html` mockup nếu monitoring stable.

## Success criteria

- [ ] 5/5 smoke test day 0 pass.
- [ ] Metric collector chạy 2 tuần, không mất data.
- [ ] Decision gate week 2 có kết luận rõ (đóng plan / spawn follow-up).
- [ ] Journal entry + wrapup submit vào OneMCP.

## Deliverable

- `plans/.../notes/smoke-test-day0.md`
- `plans/.../notes/metrics-week2.md`
- Journal + wrapup artifact.

## Unresolved questions

- OpenWebUI có expose tool call log per-session không? Nếu không → cần custom middleware hoặc parse Caddy log. **→ verify ở phase 2 khi test tools/list**.
- BookStack search có support Vietnamese diacritic-fold không? Nếu không → LLM cần tự thử cả 2 variant (có dấu / bỏ dấu). Note vào system prompt nếu miss.
- Có nên add rate limit 30 req/min ở Caddy không? YAGNI trừ khi phase 5 thấy spike.
