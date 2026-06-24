# MCP setup guide — Claude Desktop ↔ onelog

> Audience: 5 ops engineers. Time: ~10 phút/người, làm 1 lần.

## 1. Bạn cần gì trước

| Item | Verify |
|---|---|
| **Claude Desktop** đã cài | Mở app, login email công ty (workspace Claude.ai Team) |
| **Node.js ≥ 18** | Terminal: `node --version` → vd `v20.x` |
| **Bearer token cá nhân** | Hỏi ops admin (token format `sk-mcp-...`, gửi qua kênh private — KHÔNG Slack public) |
| **`app.local` resolve** | `ping app.local` → trả IP `192.168.122.53`. Nếu fail → thêm hosts file (Step 2) |

## 2. Map `app.local` (1 lần / máy)

### Windows
- Mở Notepad **as Administrator**
- File → Open: `C:\Windows\System32\drivers\etc\hosts`
- Thêm dòng cuối:
  ```
  192.168.122.53  app.local
  ```
- Save (giữ encoding ANSI/UTF-8, không thêm `.txt`)
- Verify: `ping app.local` → reply từ `192.168.122.53`

### macOS / Linux
```bash
echo "192.168.122.53  app.local" | sudo tee -a /etc/hosts
ping -c 1 app.local
```

## 3. Config Claude Desktop

### File path
| OS | Path |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` (chính xác: `C:\Users\<bạn>\AppData\Roaming\Claude\claude_desktop_config.json`) |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

Nếu file chưa tồn tại → tạo mới với nội dung dưới.

### Nội dung (replace `<YOUR_TOKEN>` bằng token admin cấp)

```json
{
  "mcpServers": {
    "onelog-vl": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "http://app.local/mcp/vl/sse",
        "--header",
        "Authorization: Bearer <YOUR_TOKEN>"
      ]
    },
    "onelog-semantic": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "http://app.local/mcp/semantic/mcp",
        "--header",
        "Authorization: Bearer <YOUR_TOKEN>"
      ]
    }
  }
}
```

**Lưu ý quan trọng:**
- Cả 2 server **dùng cùng 1 token** — không phải 2 token riêng
- `onelog-vl` endpoint là `/mcp/vl/sse` (SSE transport — official mcp-victorialogs v1.9.0)
- `onelog-semantic` endpoint là `/mcp/semantic/mcp` (Streamable HTTP — FastMCP 3.x)
- Path khác nhau là do upstream version khác nhau, không phải lỗi config

## 4. Restart Claude Desktop

**Quan trọng:** phải **full quit** chứ không phải close window.

### Windows
- Taskbar (góc phải) → right-click icon Claude → **Quit**
- Hoặc Task Manager → kill `Claude.exe`
- Mở lại app

### macOS
- Menu bar (top-right) → Claude → **Quit Claude**
- Hoặc `Cmd+Q` khi app active
- Mở lại

## 5. Verify connection

Trong cửa sổ chat mới của Claude Desktop:

### Test 1 — Liệt kê tools
Gõ:
```
What MCP tools do you have from onelog-vl and onelog-semantic?
```

Claude phải liệt kê các tool từ cả 2 server. Expect:
- **onelog-vl** (~10-12 tools): `query`, `hits`, `facets`, `field_names`, `field_values`, `stream_field_names`, `stream_field_values`, `stream_ids`, `stats_query`, `stats_query_range`, `flags` (tool `documentation` đã disable)
- **onelog-semantic** (1 tool): `search_log_templates`

Nếu Claude trả "I don't have access to those tools" → check Step 6 troubleshooting.

### Test 2 — Smoke 1 query
```
Use search_log_templates to find templates about "database disconnect"
```

Claude sẽ gọi tool, trả về list templates với `score`, `template`, `service`, `host`, `vmui_url`. Click `vmui_url` để mở raw log trong browser.

## 6. Troubleshooting

| Triệu chứng | Nguyên nhân khả nghi | Cách fix |
|---|---|---|
| Claude trả "I don't have MCP tools" | Chưa restart đủ sâu | Task Manager kill `Claude.exe` rồi mở lại |
| Config syntax error popup | JSON sai cú pháp | Validate online (jsonlint.com), check trailing comma, quote double-quote |
| `Failed to connect to onelog-*` | `app.local` không resolve | `ping app.local` — nếu fail, Step 2 |
| `401 Unauthorized` từ tool | Token sai hoặc bị revoke | Hỏi admin token mới |
| `npx mcp-remote` fail | Node cũ <18 hoặc network firewall block npm | `node --version`; nếu OK, check `npm ping` |
| Tool list show nhưng gọi không response | Server-side issue | Báo admin check `docker compose logs mcp-semantic` |
| `vmui_url` click không mở | `app.local` resolve fail trong browser | Cùng fix Step 2 (browser dùng cùng hosts file) |

## 7. Sau khi setup OK — workflow hằng ngày

Đọc tiếp [onelog-team-project-guide.md](onelog-team-project-guide.md) để biết:
- Khi nào tạo conversation trong Project `onelog-investigations` (vs personal chat)
- Naming convention conversation
- Cách share investigation với teammate

## 8. Token rotation

Khi rời team / nghi token leak / quy trình rotation định kỳ:
1. Admin chạy `infra/scripts/gen-mcp-tokens.sh <user>` sinh token mới
2. Admin update `.env` MCP_BEARER_TOKENS, restart `mcp-semantic`
3. User cập nhật token mới trong `claude_desktop_config.json` → full quit + reopen Claude Desktop

## Support

- Server-side issue → ops admin (xem audit log `/var/log/onelog-audit/mcp-semantic.log` + `docker compose logs`)
- Claude Desktop crash / npx issue → reinstall Claude Desktop / `npm install -g node@latest`
- Token / access → admin
