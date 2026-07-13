---
type: audit
date: 2026-07-13
duration: ~2h (09:05 → 11:00)
branch: master
commits: 7d0cb03, 7af85a5, 880efee (local, chưa push)
---

# Session 2026-07-13 · Storage decom + silent pipeline regression

## Điều đã xong

| # | Việc | Kết quả |
|---|---|---|
| 1 | Rà data lưu ở đâu (theo mockup topology) | 6 store: VL, Qdrant, PG, NATS, OWU SQLite, sqlite-web |
| 2 | Verify PG runtime (2 lần đảo ngược recommend) | Orphan thật (last write 2026-06-23, 0 connection) |
| 3 | Decom PG | Compose commented, dump 28KB, data → `postgres.legacy-260713/` |
| 4 | Rà Redis + sqlite-web | Redis orphan (DBSIZE=0), sqlite-web hữu ích (read-only viewer OWU DB) |
| 5 | Decom Redis + document sqlite-web | 1 commit |
| 6 | Verify Drain3 empty state | Phát hiện incident thật |
| 7 | **Debug NATS fetch fail 3 ngày** | Root cause: mock-logs stopped, 0 WARN+ events |
| 8 | Add vmalert rule `WarnEventsStale` | Detect next silent regression |

## Lesson chính: **Verify runtime > đọc code**

### Iteration 1 — nhận định sai
Đọc code: LiteLLM DB disabled, MCP semantic ghi JSON Lines, indexer không import PG → PG orphan. **Wrong**.

### Iteration 2 — verify chi tiết hơn
Query PG có 4 table + 116k xact_commit → chững lại, giả định "có kẻ đang dùng". **Also wrong direction**.

### Iteration 3 — verify từng gap
- `pg_stat_user_tables.last_autovacuum` = NULL → chưa từng vacuum → thật sự idle
- `pg_stat_activity` khi không có psql → 0 connection → thật sự orphan
- Data từ 2026-06-23 (khớp ngày decom web/agent legacy)

Ba lần verify runtime khác nhau. Đọc code lần đầu → suy diễn sai. Chỉ khi query `pg_stat_*` mới ra kết luận chính xác.

## Lesson phụ: Silent regression **nguy hiểm hơn** noisy failure

**Bug NATS fetch:**
- `err: ""` empty message → dễ bỏ qua
- Không rule vmalert nào bắn (0 event ≠ threshold violation trong rule cũ)
- Data flow BROKEN 3 ngày trước khi được phát hiện tình cờ

**Nguyên tắc**: mọi pipeline cần **liveness probe** — không chỉ threshold, mà cả "stale > N phút".

## Findings kỹ thuật

### PG decom bằng chứng
```
pg_stat_activity (no psql): 0 rows
pg_stat_user_tables: last_autovacuum=NULL, n_tup_ins=[1,2,3,6,43]
  → tất cả từ 2026-06-23 (legacy Next.js web + old agent)
Env container ragstack-*: 0 container có DATABASE_URL
```

### NATS fetch_failed root cause
```
Vector connection: idle 2d18h, in_msgs:5, out_msgs:0
NATS stream LOGS: last_ts 2026-07-10T08:55:01Z, messages:12
Indexer consumer: num_pending:0, num_waiting:1 (caught up)
VL query: severity WARN+ trong 3 ngày = 0 events
Vector tap: mọi event severity="info" (chỉ DHCPDISCOVER)
```

Kết luận: pipeline hoạt động đúng, **input toàn info** vì `mock-logs.service` trên srv-01/srv-02 stopped.

## Bug thứ 2 — CRITICAL: Vector VL sink thiếu input `redact`

Khi verify mock-logs restart, phát hiện VL query `host:srv-*` = **0** dù NATS có 484 events. Root cause: [vector.yaml:344](infra/vector/vector.yaml#L344) sink `victorialogs` chỉ có inputs `[tag_litellm_cost, openwebui_db_parse, tag_provider_cost, logserver_disk_parse]` — **thiếu `redact`** (transform xử lý syslog/rsyslog).

Comment ở dòng 340-341 sai/misleading: nói `tag_litellm_cost = all PII-redacted syslog/rsyslog events`, nhưng thực tế transform này chỉ tag LiteLLM cost records ([vector.yaml:175-184](infra/vector/vector.yaml#L175-L184)).

**Impact production**:
- LogsQL search qua Claude Desktop `mcp-vl` / OpenWebUI MISS toàn bộ log srv-01/02
- Semantic search ra template + `vmui_url` nhưng click vào → rỗng
- Timeline khả năng broken từ **2026-07-02** (llm-abstraction rollout — cấu trúc lại VL sink inputs)
- **KHÔNG alert nào** — silent bug production tuần thứ 2

**Fix**: Add `redact` vào inputs list. Verify sau restart Vector: `host:srv-* _time:5m = 646 events` (distribution info=434, warning=130, err=70).

**Regression commit xác định**: `0317390 fix(vector): read LiteLLM stdout via docker_logs source`. Refactor đổi `tag_litellm_cost.inputs: [redact] → [docker_litellm]` — dụng ý fix LiteLLM cost source nhưng đồng thời **cắt đường syslog → VL** vì không add `redact` vào VL sink inputs riêng. Bug tồn tại từ đó (commit trước `1d51a53 feat(ops): disk rotation strategy`, ước lượng 2026-07-02 khi llm-abstraction rollout).

Ghi chú thêm: commit `274e309 .` (chỉ dấu chấm) xuất hiện trong log — auto-commit hook lộn xộn (giống case `ceb7a0f .` session này). Có thể là commit khác cùng góp phần regression, hoặc chỉ noise.

## Backlog còn lại

1. 🔴 **Agent audit regression** — `/chat` SSE không ghi audit ở đâu (env chỉ có VL_URL, QDRANT_COLLECTION, LOG_LEVEL). Cần plan Option A: agent → JSON Lines → Vector → VL
2. 🔴 **Add smoke test post-deploy**: `curl VL host:srv-* _time:5m | count > 0` — chống regression cùng loại
3. 🔴 **Điều tra timeline redact bị loại khỏi VL sink**: `git log -p infra/vector/vector.yaml | grep -B5 -A5 "tag_litellm_cost.*openwebui"` — tìm commit gây regression
4. 🟠 **4 file drift trên logserver** chưa commit (Caddyfile, openwebui-db-maintenance.sh, poll-provider-cost.sh, probe-openwebui-db.sh)
5. 🟡 **Hack `filter value:>-1`** trong rules.yml (chưa rõ ai/khi nào)
6. 🟡 **Timeline mock-logs 06-23 → 07-10** (17 ngày WARN+ đến từ đâu — real syslog hay ai chạy manual?)
7. 🟢 **Clean web/src/db/** legacy code (sau khi confirm không resurrect)

## Commits shipped session này

| Hash | Nội dung |
|---|---|
| `7d0cb03` | chore(postgres): decommission legacy postgres |
| `7af85a5` | chore(redis+sqlite-web): decom redis, document sqlite-web |
| `880efee` | feat(vmalert): WarnEventsStale rule (safety net) |
| `5676d7e` | **fix(vector): restore redact input to VL sink** ← critical |

## Unresolved

- Vì sao mock-logs.service tự stop 2026-07-10 08:55? OOM? Systemd fail? Manual stop lúc production-deploy phase?
- WarnEventsStale threshold `< 1 / 30m` — có thể false positive nếu system thực sự healthy zero. Cân nhắc thay bằng canary probe explicit.
- Postgres.legacy-260713 sau 30 ngày (2026-08-13) xóa hẳn hay giữ archive tar.gz?
