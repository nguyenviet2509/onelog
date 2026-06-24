# Phase 01 — Expose `/metrics` endpoints + Caddy auth route

## Context
- Plan: [plan.md](plan.md)
- Decision: [brainstorm-260624-1343-observability-integration](../reports/brainstorm-260624-1343-observability-integration.md)
- Blocked by: Phase 02 mcp-only-rollout soak xong (production-stable)

## Overview
- Priority: P1
- Status: pending
- Effort: ~1.0 ngày-người
- Mục tiêu: 5 endpoint `/metrics` (mcp-semantic, mcp-vl, VictoriaLogs, Qdrant, Caddy) reachable qua Caddy với IP allowlist + basic auth, sẵn sàng cho team Prom scrape.

## Key insights
- VictoriaLogs `:9428/metrics` native (built-in Prom exposition)
- Qdrant `:6333/metrics` native (kể từ v1.x)
- Caddy admin API `:2019/metrics` native — phải expose qua route tách riêng (admin API không nên public)
- mcp-semantic CHƯA có `/metrics` → cần add `prometheus_client`
- mcp-vl (ghcr.io/victoriametrics/mcp-victorialogs:v1.9.0) UNVERIFIED có native `/metrics` chưa → check README. Nếu không → fallback synth blackbox probe `/sse` health từ team Prom

## Architecture
```
Team Prom (LAN/VPN)
   │ basic auth + IP allowlist
   ▼
Caddy :80 /metrics/<service>
   ├── /metrics/mcp-semantic  → mcp-semantic:9000/metrics
   ├── /metrics/mcp-vl        → mcp-vl:8000/metrics (or skip → blackbox)
   ├── /metrics/victorialogs  → victorialogs:9428/metrics
   ├── /metrics/qdrant        → qdrant:6333/metrics
   └── /metrics/caddy         → localhost:2019/metrics
```

## Related files

**Modify:**
- `mcp-semantic/pyproject.toml` — add dep `prometheus-client>=0.20`
- `mcp-semantic/src/mcp_semantic/main.py` — register `/metrics` route (FastAPI), khởi tạo counter `mcp_request_total{user, event, status}`, increment trong audit path
- `mcp-semantic/src/mcp_semantic/audit.py` — hook tăng counter sau khi write JSON line
- `infra/caddy/Caddyfile` — thêm block route `/metrics/<service>` với `basicauth` + `@allowed_ips` matcher
- `infra/.env.example` — thêm `PROM_ALLOWED_IPS=10.x.x.x/24`, `PROM_BASIC_AUTH_USER=prom`, `PROM_BASIC_AUTH_PWD=<random>`
- `infra/docker-compose.yml` — pass env mới vào Caddy service

**Create:**
- `mcp-semantic/src/mcp_semantic/metrics.py` — counter/gauge định nghĩa tập trung (KISS, tách khỏi main)

## Implementation steps

### Step 1 — Add prometheus_client cho mcp-semantic (0.4d)
1. `cd mcp-semantic && uv add prometheus-client` (hoặc edit pyproject + `uv sync`)
2. Tạo `mcp-semantic/src/mcp_semantic/metrics.py`:
   - `mcp_request_total = Counter("mcp_request_total", "MCP tool calls", ["user","event","status"])`
   - Limit cardinality: `event` chỉ tool name (whitelist), `status` ∈ {ok, denied, error}, `user` từ Bearer map (5 fixed values)
3. Trong `main.py`: mount `/metrics` route → `generate_latest()` từ prometheus_client; content-type `text/plain; version=0.0.4`
4. Trong `audit.py` (hoặc tool wrapper): increment counter mỗi request sau khi xác định user + status
5. Smoke: `curl http://localhost:9000/metrics` → thấy `mcp_request_total` series

### Step 2 — Verify upstream native /metrics (0.2d)
1. `docker exec onelog-victorialogs wget -qO- http://localhost:9428/metrics | head` → confirm
2. `docker exec onelog-qdrant wget -qO- http://localhost:6333/metrics | head` → confirm metric names
3. `curl http://localhost:2019/metrics` từ host (Caddy admin) → confirm
4. mcp-vl: `docker exec onelog-mcp-vl wget -qO- http://localhost:8000/metrics` → nếu 404, đánh dấu cần fallback blackbox (note trong Phase 02), KHÔNG patch upstream code

### Step 3 — Caddy auth route (0.3d)
1. Edit `infra/caddy/Caddyfile`, thêm trong block site chính:
```
@prom_allowed {
    remote_ip {$PROM_ALLOWED_IPS}
}
handle_path /metrics/mcp-semantic {
    basicauth {
        {$PROM_BASIC_AUTH_USER} {$PROM_BASIC_AUTH_PWD_HASH}
    }
    @prom_allowed reverse_proxy mcp-semantic:9000
    respond 403
}
# lặp tương tự cho victorialogs, qdrant, caddy(:2019), mcp-vl
```
2. Generate pwd hash: `caddy hash-password --plaintext '<pwd>'` → set `PROM_BASIC_AUTH_PWD_HASH` trong `.env`
3. Reload Caddy: `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`

### Step 4 — Verification (0.1d)
1. Từ logserver host (giả lập team Prom IP qua allowlist test):
   - `curl -u prom:<pwd> http://localhost/metrics/mcp-semantic` → 200, có series
   - `curl http://localhost/metrics/mcp-semantic` (no auth) → 401
   - `curl -u wrong:wrong http://localhost/metrics/mcp-semantic` → 401
2. Từ IP ngoài allowlist → 403
3. Tất cả 5 endpoint reachable

## Todo
- [ ] Add `prometheus-client` dependency
- [ ] Implement `metrics.py` với counter + cardinality limit
- [ ] Mount `/metrics` route trong main.py
- [ ] Hook increment trong audit path
- [ ] Verify VL/Qdrant/Caddy native metrics
- [ ] Check mcp-vl native metrics (note fallback nếu cần)
- [ ] Caddy route + basic auth + IP allowlist
- [ ] Env vars vào `.env.example`
- [ ] Smoke 5 endpoint từ localhost
- [ ] Smoke 401/403 negative cases

## Success criteria
- 5 endpoint `/metrics/<service>` trả 200 + data Prom format khi gọi với basic auth từ IP allowlisted
- 401 nếu thiếu/sai auth, 403 nếu IP ngoài allowlist
- Counter `mcp_request_total` tăng đúng khi gọi MCP tool
- Cardinality `mcp_request_total` ≤ 5 user × ~10 tool × 3 status = 150 series

## Risks
- mcp-vl upstream image không expose `/metrics` → đánh dấu skip, Phase 02 dùng blackbox probe `/sse`. Không patch upstream (out of scope).
- Counter cardinality blow-up nếu vô tình truyền raw query làm label → ENFORCE whitelist label values.
- Caddy basic auth hash format yêu cầu bcrypt — verify `caddy hash-password` output dùng đúng env var name.

## Security
- Plain HTTP qua LAN/VPN OK (đã rule trong brainstorm); nếu migrate Internet → trigger HTTPS Phase 04 separate
- Basic auth pwd random ≥24 chars, không commit raw vào git, chỉ `.env.example` placeholder
- IP allowlist là defense chính, basic auth là defense-in-depth

## Unresolved questions
- mcp-vl v1.9.0 có expose `/metrics` native không? (cần test thực tế khi triển khai)
- Caddy admin API `:2019` chỉ listen `localhost` mặc định — reverse_proxy từ Caddy đến chính nó qua `localhost:2019` có work trong container Caddy không? (có thể cần `--admin :2019` flag)
