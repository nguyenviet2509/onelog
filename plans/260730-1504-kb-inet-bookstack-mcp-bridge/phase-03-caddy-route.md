# Phase 3 — Caddy route `/mcp/kb` (OPTIONAL / DEFERRED)

**Status:** deferred
**Priority:** P3 (chỉ cần nếu có client external)
**Effort:** ~30 min
**Depends on:** Phase 2

## ⚠️ Lý do defer

Scout xác nhận OpenWebUI gọi MCP server qua **docker internal network** (`http://bookstack-mcp:8080/mcp`), không đi qua Caddy. Không cần expose ra ngoài cho MVP.

Chỉ implement phase này nếu:
- Client external (Claude Desktop dev laptop) muốn dùng bookstack-mcp
- Test tools/list từ máy dev không nằm trong docker network
- Debug từ browser MCP inspector

Nếu chỉ dùng qua OpenWebUI chat → **SKIP** phase này hoàn toàn.


## Mục tiêu

Expose `bookstack-mcp` qua Caddy edge tại `https://onelog.inet.vn/mcp/kb/*` để OpenWebUI (external or internal) truy cập được.

## Files to modify

- `d:\Vietnt\Project\onelog\infra\caddy\Caddyfile` (hoặc file config Caddy hiện tại)

## Implementation

Grep pattern hiện có (mcp-vl có sẵn route `/mcp/vl/*`) → copy pattern.

```
onelog.inet.vn {
    # ... existing routes ...

    # BookStack MCP (KB.inet bridge, read-only)
    handle_path /mcp/kb/* {
        reverse_proxy bookstack-mcp:8080 {
            header_up Host {upstream_hostport}
            transport http {
                read_timeout 30s
            }
        }
    }
}
```

**Lưu ý streamable HTTP**:
- bookstack-mcp mount tại `/mcp` (theo `MCP_HTTP_PATH`).
- `handle_path` strip prefix `/mcp/kb` → forward `/*` tới upstream, thành `/mcp/kb/*` ở client, `/*` ở upstream. **Sai.** Cần map đúng:

**Đúng cách** (dùng `handle` không strip, upstream mount `/mcp`):
```
handle /mcp/kb {
    reverse_proxy bookstack-mcp:8080/mcp
}
handle /mcp/kb/* {
    rewrite * /mcp{uri.path.drop_prefix('/mcp/kb')}
    reverse_proxy bookstack-mcp:8080
}
```

**Hoặc đơn giản hơn** — set `MCP_HTTP_PATH=/mcp/kb` trong compose (phase 2), Caddy chỉ cần:
```
handle /mcp/kb/* {
    reverse_proxy bookstack-mcp:8080
}
```
→ **Recommend cách này**, ít lỗi routing.

**Cập nhật Phase 2** nếu chọn cách này: đổi `MCP_HTTP_PATH: /mcp/kb`.

### Auth ở edge

Nếu OpenWebUI đã có SSO / basic auth ở đường vào chat thì đủ. Nếu cần thêm 1 lớp bảo vệ endpoint MCP:
```
handle /mcp/kb/* {
    basicauth {
        openwebui $2a$14$...  # bcrypt hash
    }
    reverse_proxy bookstack-mcp:8080
}
```
→ OpenWebUI config MCP endpoint kèm basic auth header.

## Deploy

1. Edit Caddyfile local → commit → push → pull VPS.
2. `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.
3. Test từ ngoài:
   ```bash
   curl -sS https://onelog.inet.vn/mcp/kb -H "Accept: application/json" \
     -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
   ```

## Success criteria

- [ ] `curl` public URL trả tools/list thành công.
- [ ] Caddy log không có 502.
- [ ] TLS OK (cert valid).

## Risks

- Route conflict với `/mcp/vl` hoặc `/mcp` gốc → test kỹ order rules trong Caddyfile.
- CORS: bookstack-mcp streamable HTTP dùng SSE → verify OpenWebUI không block Origin. **Mitigate:** nếu block, add `header Access-Control-Allow-Origin` ở Caddy.
