# PoC Deployment Guide — RAG Log Server (3 demo servers)

Hướng dẫn triển khai bản proof-of-concept: 1 máy log server + 3 server demo gửi log.

## Topology

```
┌─────────────────────────────────────────┐
│  Log Server (Ubuntu 22.04/24.04 VM)     │
│  16 vCPU · 32GB RAM · 1TB SSD          │
│                                         │
│  docker-compose:                        │
│    - VictoriaLogs   (:9428 local)       │
│    - Qdrant         (:6333 local)       │
│    - Postgres       (:5432 local)       │
│    - Redis          (:6379 local)       │
│    - Vector         (:514/udp, :6514)   │
│    - mcp-vl         (:8001 local)       │  ← official MCP server
│    - Caddy          (:80, :443)         │
└──────────────▲──────────────────────────┘
               │ syslog UDP 514
        ┌──────┼──────┐
        │      │      │
   ┌────┴┐ ┌──┴─┐ ┌──┴──┐
   │mail │ │srv1│ │ srv2│   ← 3 demo Linux servers
   │  01 │ │    │ │     │     rsyslog forward
   └─────┘ └────┘ └─────┘
```

## Cấu trúc thư mục dự án

```
vietnt/
├── infra/
│   ├── docker-compose.yml             # 7 service: VL, Qdrant, Postgres, Redis, Vector, mcp-vl, Caddy
│   ├── .env.example
│   ├── caddy/Caddyfile                # routes: /vmui, /mcp/vl, /vl-api, mockups
│   ├── vector/vector.yaml             # syslog → enrich → redact (PII) → VL
│   ├── clients/rsyslog-forward.conf   # drop vào /etc/rsyslog.d/ trên 3 demo server
│   └── scripts/setup-log-server.sh
├── mockups/                           # static HTML preview UX
│   ├── index.html
│   ├── chat.html                      # Q&A ChatGPT-like, citation deep-link vmui
│   ├── trace.html                     # iframe vmui + Ask AI overlay
│   ├── admin-audit.html
│   ├── admin-cost.html
│   ├── admin-health.html
│   └── settings.html                  # MCP token config 2 server
├── plans/260622-1056-rag-logserver-victorialogs/
│   ├── plan.md
│   └── phase-{01..08}-*.md
└── docs/
    └── poc-deployment-guide.md (file này)
```

## Lab deployment — VM mapping cụ thể

Với lab vSphere có sẵn nhiều VM Ubuntu 24.04 (`192.168.122.x`, 4 vCPU / 4GB RAM / 60GB disk):

| Role | VM gợi ý | Cài đặt |
|---|---|---|
| **Log server** | `vietnt_ubuntu_24_04_192.168.122.52` | Docker stack |
| Demo client 1 (mail-01) | `192.168.122.50` | rsyslog forward |
| Demo client 2 (srv-01) | `192.168.122.51` | rsyslog forward |
| Demo client 3 (srv-02) | Chọn 1 VM khác | rsyslog forward |

**Constraint resource**: 4GB RAM chặt cho full stack. PoC bước 1 chỉ chạy **5 service core** (skip Redis, mcp-vl) → đủ RAM (~1.5 GB).

### Profile trong docker-compose

| Profile | Service start | Khi nào dùng | RAM |
|---|---|---|---|
| (default) | VL + Qdrant + Postgres + Vector + Caddy | **PoC bước 1** — log ingest + vmui + mockups | ~1.5 GB |
| `mcp` | + mcp-vl | Test MCP từ Claude Desktop | +100 MB |
| `agent` | + Redis | Phase 03 agent service | +128 MB |

Lệnh:
```bash
docker compose up -d                                    # bước 1
docker compose --profile mcp up -d                      # +MCP
docker compose --profile mcp --profile agent up -d      # full stack
```

### Pre-flight check trên log server VM

```bash
# 1. Outbound internet (pull docker image)
curl -fI https://download.docker.com    # phải 200

# 2. (Sau khi có LLM key) LLM API reachable
curl -fI https://api.anthropic.com      # phải 200
curl -fI https://api.openai.com         # phải 200

# 3. NTP sync
timedatectl status                       # System clock synchronized: yes

# 4. Tới được 3 demo VM
ping -c 2 192.168.122.50
ping -c 2 192.168.122.51

# 5. Disk
df -h /                                  # > 50GB free
```

## Bước 1 — Chuẩn bị log server

Trên VM Ubuntu, copy thư mục `infra/` + `mockups/` lên `/opt/ragstack/`:

```bash
# từ máy dev
rsync -av infra/ mockups/ user@LOG_SERVER_IP:/opt/ragstack/
```

Trên VM log server:

```bash
cd /opt/ragstack
sudo bash scripts/setup-log-server.sh  # cài Docker, mở firewall
cp .env.example .env
nano .env                              # điền API keys, password
docker compose up -d
docker compose ps                      # kiểm tra 6/6 healthy
```

Smoke test:
```bash
curl http://localhost:9428/health      # VictoriaLogs OK
curl http://localhost:6333/healthz     # Qdrant OK
curl http://localhost:8686/health      # Vector OK
curl http://localhost:8001/health      # mcp-victorialogs OK (nếu service chạy)
docker compose ps                      # 7/7 healthy
```

## Bước 2 — Cấu hình 3 server demo

Trên mỗi server demo (mail-01, srv-01, srv-02):

```bash
# Copy rsyslog template
sudo cp infra/clients/rsyslog-forward.conf /etc/rsyslog.d/90-forward-ragstack.conf

# Thay LOG_SERVER_IP bằng IP thật của VM log server
sudo sed -i 's/LOG_SERVER_IP/192.168.1.100/' /etc/rsyslog.d/90-forward-ragstack.conf

# Reload
sudo systemctl restart rsyslog

# Test
logger -t demo-test "hello from $(hostname)"
```

Trên log server kiểm tra log đã vào VictoriaLogs chưa:
```bash
curl -G "http://localhost:9428/select/logsql/query" \
  --data-urlencode 'query=_stream:{host=mail-01} | last 5m' \
  --data-urlencode 'limit=10'
```

### 2b. Test PII redaction (bắt buộc)

PII bị strip ở **Vector VRL transform** ngay tại ingest — log vào VictoriaLogs phải đã clean. Test:

```bash
# Inject log có email + private IP + JWT + Bearer token + password
logger -n LOG_SERVER_IP -P 514 -t pii-test "user=admin@company.com client_ip=10.20.30.40 token=Bearer abc123xyz password=secret123 jwt=eyJhbGciOi.eyJzdWIi.signedpart"

# Đợi 3s rồi query VL — KHÔNG được thấy giá trị raw
curl -G "http://LOG_SERVER_IP:9428/select/logsql/query" \
  --data-urlencode 'query=_msg:pii-test' --data-urlencode 'limit=5'
```

Kỳ vọng: message hiển thị `<EMAIL>`, `<PRIV_IP>`, `<JWT>`, `<TOKEN>`, `password=<REDACTED>`. Nếu thấy raw → kiểm tra `infra/vector/vector.yaml` transform `redact` có nối đúng vào sink chưa.

Pattern redact đang dùng (xem `vector.yaml`):
- Email
- Private IPv4 RFC1918 (10.x, 172.16-31.x, 192.168.x)
- JWT (3 đoạn base64)
- AWS access key (AKIA...)
- HTTP Bearer token
- Password / passwd / pwd fields

Nếu cần thêm pattern (vd: số thẻ tín dụng, số CCCD), bổ sung vào VRL `redact` source và restart Vector.

## Bước 3 — Preview Mock UI

Caddy đã mount `mockups/` ở route `/`. Mở browser từ máy trong LAN:

```
http://LOG_SERVER_IP/          → index.html (landing)
http://LOG_SERVER_IP/chat.html
http://LOG_SERVER_IP/trace.html
http://LOG_SERVER_IP/admin-audit.html
http://LOG_SERVER_IP/admin-cost.html
http://LOG_SERVER_IP/admin-health.html
http://LOG_SERVER_IP/settings.html
```

Hoặc local trên máy dev không cần stack:
```bash
cd mockups
python -m http.server 8000
# mở http://localhost:8000
```

Caddyfile mặc định chỉ cho LAN CIDR `192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`, `127.0.0.1`. Chỉnh `Caddyfile` nếu mạng khác.

## Bước 3b — Test MCP official (mcp-victorialogs)

Sau khi VL có log, test MCP server official từ máy dev (cần Claude Desktop hoặc CLI MCP client):

### Option 1 — Claude Desktop

Chỉnh `claude_desktop_config.json` (Mac: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "logserver-vl": {
      "url": "http://LOG_SERVER_IP/mcp/vl/sse"
    }
  }
}
```

Restart Claude Desktop → hỏi: *"List services in last hour from logserver"* → Claude phải gọi tool `field_values` và trả list (postfix, dovecot, sshd, nginx, ...).

### Option 2 — Curl test SSE endpoint

```bash
curl -N http://LOG_SERVER_IP/mcp/vl/sse
# Phải nhận event "endpoint" với session URL → MCP handshake OK
```

12 tool có sẵn (xem [phase-08](../plans/260622-1056-rag-logserver-victorialogs/phase-08-mcp-server.md)):
`query`, `hits`, `facets`, `field_names`, `field_values`, `stream_field_names`, `stream_field_values`, `stream_ids`, `stats_query`, `stats_query_range`, `flags`, `documentation`.

Custom semantic MCP (`/mcp/semantic/*`) chưa deploy ở PoC — sẽ thêm Phase 08 sau khi indexer + Qdrant có data.

## Bước 4 — Workflow tiếp theo

Sau khi xác nhận:
- Log từ 3 server vào VictoriaLogs đều đặn
- Mock UI hiển thị đúng kỳ vọng (chat / trace / admin)

→ Tiến hành theo plan [`plans/260622-1056-rag-logserver-victorialogs/`](../plans/260622-1056-rag-logserver-victorialogs/plan.md):

| Bước | Phase | Thực hiện |
|---|---|---|
| 1 | 02 | Bổ sung filter WARN+ + NATS + Indexer worker (Drain3 + redact + embed → Qdrant) |
| 2 | 03 | Code agent FastAPI + LangGraph + 4 tools, persist Postgres |
| 3 | 04 | Build Next.js Web app thay mock HTML, BFF SSE proxy tới agent |
| 4 | 05 | Eval harness 20 case |
| 5 | 06 | Alertmanager + Telegram alert minimal |
| 6 | 08 | Custom MCP semantic Qdrant (official mcp-vl đã có ở PoC) |

## Troubleshooting

| Triệu chứng | Kiểm tra |
|---|---|
| `docker compose up` báo cổng 514 bận | `sudo ss -ulpn \| grep 514` (rsyslog/syslog-ng đang chạy local?) — dừng nó hoặc đổi port Vector |
| Log không vào VictoriaLogs | `docker compose logs vector` xem có decode syslog OK không; trên server demo: `sudo systemctl status rsyslog` |
| Caddy không lên | `docker compose logs caddy` — thường do quyền file Caddyfile hoặc DNS APP_DOMAIN sai |
| Qdrant không persist | Mount `./data/qdrant` có quyền write không (`chown -R 1000:1000 data/qdrant`) |
| Mock UI 403 | IP của bạn không trong CIDR allow list — sửa `caddy/Caddyfile` |
| Log vào VL còn raw PII | Vector transform `redact` chưa chain đúng vào sink — kiểm `infra/vector/vector.yaml` `inputs: [redact]` |
| mcp-vl không lên | `docker compose logs mcp-vl` — thường thiếu `VL_INSTANCE_ENTRYPOINT` hoặc VL chưa healthy |
| Claude Desktop không thấy tool | URL phải có `/sse` cuối; check Caddy log `/mcp/vl/*` route forward đúng port 8000 |

## Sizing thực tế PoC (3 server)

| Resource | Đủ |
|---|---|
| CPU | 4 vCPU |
| RAM | 8 GB |
| Disk | 100 GB |

Production 50-200 server → upgrade theo `plan.md` §sizing (16/32/1TB).

## Bảo mật PoC

- Chưa có auth Web → **bắt buộc giữ trong LAN**, không expose public
- Caddy IP whitelist là biện pháp tạm (subnet `192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`)
- Tất cả service nội bộ bind `127.0.0.1` qua docker network (không public direct)
- `.env` chứa secret → KHÔNG commit, dùng `.gitignore`
- **PII redact ở Vector ingest** — log vào VL đã clean trước khi tool nào (MCP, agent, vmui) đọc
- mcp-victorialogs chưa bật Bearer auth ở PoC — chấp nhận vì IP whitelist + LAN only. Khi expose public phải set `MCP_PASSTHROUGH_HEADERS=Authorization` + Caddy validate token Postgres

## MCP Architecture (Phase 08)

```
IDE (Claude Desktop/Code)
  ├── logserver-vl       → /mcp/vl/sse       → mcp-victorialogs (12 tool official)
  │                                              └── VictoriaLogs (data đã redact)
  └── logserver-semantic → /mcp/semantic/sse → custom FastMCP (Phase 08, chưa deploy PoC)
                                                  └── Qdrant (templates đã Drain3 embed)
```

Official mcp-victorialogs đã deploy ở PoC (`mcp-vl` service). Custom semantic deploy sau khi indexer Phase 02 chạy có data trong Qdrant.
