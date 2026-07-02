# MCP setup guide — onelog

> Audience: 5 ops engineers. Time: ~5 phút/người, làm 1 lần.
> Từ 2026-07, path chính là **OpenWebUI** (self-hosted). Claude Desktop giữ làm appendix (legacy, tồn tại ít nhất đến D+30 post-migration).

## 1. Overview

| Path | Khi nào dùng | Setup effort |
|---|---|---|
| **A. OpenWebUI** (chính) | Log investigation daily, đa provider (Claude/Gemini/GPT/DeepSeek) | 5 phút — hosts entry + login |
| B. Claude Desktop (legacy) | Đang trong giai đoạn migration, hoặc muốn native desktop UI | 10 phút — config JSON + token |
| C. Cursor / Continue.dev (optional) | Dev muốn dùng MCP trong IDE | Xem Appendix B |

**Recommend:** dùng OpenWebUI. Claude Desktop sẽ revoke MCP token đợt cuối vào D+21 sau cutover.

---

## 2. Setup OpenWebUI (main path)

### 2.1 Chuẩn bị — thêm hosts entry (1 lần)

Map `webui.local` → `192.168.122.53`:

- **Windows** (PowerShell as Admin):
  ```powershell
  Add-Content -Path "$env:windir\System32\drivers\etc\hosts" -Value "192.168.122.53  webui.local"
  ```
- **macOS / Linux**:
  ```bash
  echo "192.168.122.53  webui.local" | sudo tee -a /etc/hosts
  ```

Verify: `ping webui.local` → reply `192.168.122.53`.

**Tip:** thêm luôn `192.168.122.53  app.local` cùng lúc — cần cho `vmui_url` citation click mở raw log.

### 2.2 Đăng nhập

- Admin gửi bạn email + password tạm qua kênh private (KHÔNG Slack public).
- Mở `http://webui.local/` → login → **đổi password ngay** (Settings → Account).

### 2.3 Chọn model

- Model picker (dropdown top) — 4 alias: `claude-sonnet`, `gemini-flash`, `gpt-4-mini`, `deepseek`.
- Default: `claude-sonnet` (tool-use fidelity tốt nhất).
- Đổi sang `gemini-flash` cho query đơn giản để tiết kiệm cost (~10x rẻ).

### 2.4 Verify MCP tools

Icon MCP cạnh input → click để expand → phải thấy:

- **onelog-vl** (~11 tool): `query`, `hits`, `facets`, `field_names`, `field_values`, `stream_field_names`, `stream_field_values`, `stream_ids`, `stats_query`, `stats_query_range`, `flags`
- **onelog-semantic** (1 tool): `search_log_templates`

Nếu list rỗng → xem §3 Troubleshooting.

### 2.5 Chat mẫu

```
Use search_log_templates to find templates about "mysql disconnect"
```

Kỳ vọng: response VI có citation `[service:host:timestamp]` + `vmui_url` clickable. Click URL → mở raw log VMUI.

**Đọc tiếp:** [openwebui-user-guide.md](openwebui-user-guide.md) — chọn model, workspace, share chat, keyboard shortcut.

---

## 3. Troubleshooting

| Triệu chứng | Fix |
|---|---|
| `webui.local` không mở | `ping webui.local` — nếu fail, redo §2.1 |
| Login "Failed to connect to backend" | Báo admin — LiteLLM proxy có thể down |
| Model list rỗng | Báo admin — virtual key null / hết budget |
| MCP icon show 0 tool | Báo admin — `MCP_TOKEN_OPENWEBUI` có thể sai / hết hạn |
| Tool call fail nhưng model có gọi | Đổi model `claude-sonnet` (tool fidelity tốt hơn) |
| Citation `vmui_url` không mở | Thiếu `app.local` trong hosts — thêm dòng `192.168.122.53 app.local` |
| Chat load chậm / timeout | Provider rate-limit — refresh, đổi model khác |

Server-side issue → ops admin (`docker compose logs openwebui litellm-proxy`).

---

## Appendix A — Claude Desktop (legacy)

> Setup này còn hỗ trợ đến D+21 sau OpenWebUI cutover. Sau đó MCP token sẽ revoke.
> Chỉ dùng nếu bạn chưa migrate xong sang OpenWebUI (path chính §2).

### A.1 Yêu cầu

| Item | Verify |
|---|---|
| Claude Desktop đã cài | Mở app, login email công ty |
| Node.js ≥ 18 | Terminal: `node --version` → vd `v20.x` |
| Bearer token cá nhân | Hỏi ops admin — token `sk-mcp-...`, gửi qua kênh private |
| `app.local` resolve | `ping app.local` → `192.168.122.53`. Fail → xem §A.2 |

### A.2 Map `app.local`

**Windows** (Notepad as Admin):
- File `C:\Windows\System32\drivers\etc\hosts` → thêm `192.168.122.53  app.local` → Save (encoding ANSI/UTF-8).

**macOS / Linux**:
```bash
echo "192.168.122.53  app.local" | sudo tee -a /etc/hosts
```

### A.3 Config Claude Desktop

**File path:**
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Nội dung** (Windows — dùng `npx.cmd`):
```json
{
  "mcpServers": {
    "onelog-vl": {
      "command": "npx.cmd",
      "args": ["-y", "mcp-remote@latest", "http://app.local/mcp/vl/sse",
               "--allow-http",
               "--header", "Authorization: Bearer <YOUR_TOKEN>"]
    },
    "onelog-semantic": {
      "command": "npx.cmd",
      "args": ["-y", "mcp-remote@latest", "http://app.local/mcp/semantic/mcp",
               "--header", "Authorization: Bearer <YOUR_TOKEN>"]
    }
  }
}
```

**macOS / Linux:** thay `npx.cmd` → `npx`.

**Lưu ý:**
- 2 server dùng **cùng 1 token**.
- `onelog-vl` endpoint `/mcp/vl/sse` (SSE), `onelog-semantic` endpoint `/mcp/semantic/mcp` (Streamable HTTP).
- Windows dùng `npx.cmd` (không `npx`) — Claude Desktop spawn qua `cmd /C` không xử lý PATH space.
- `--allow-http` bắt buộc — mcp-remote block HTTP non-localhost mặc định.

### A.4 Restart Claude Desktop

**Full quit** (không phải close window):
- Windows: taskbar right-click Claude → Quit. Hoặc Task Manager kill `Claude.exe`.
- macOS: menu bar → Claude → Quit Claude. Hoặc `Cmd+Q`.

### A.5 Verify

Chat mới:
```
What MCP tools do you have from onelog-vl and onelog-semantic?
```

Claude phải liệt kê tool. Nếu "I don't have access" → check config JSON + restart lại.

### A.6 Troubleshooting Claude Desktop

| Triệu chứng | Fix |
|---|---|
| "I don't have MCP tools" | Chưa restart đủ sâu — Task Manager kill `Claude.exe` |
| Config syntax popup | JSON sai — validate jsonlint.com |
| `Failed to connect` | `ping app.local` — nếu fail redo §A.2 |
| `401 Unauthorized` | Token sai / bị revoke — hỏi admin |
| Windows `'C:\Program' is not recognized` | Đổi `"command": "npx"` → `"npx.cmd"` |
| `Non-HTTPS URLs are only allowed for localhost` | Thêm `--allow-http` trong args |

### A.7 Token rotation

Khi rời team / nghi leak / rotation quarterly:
1. Admin: `infra/scripts/gen-mcp-tokens.sh <user>` sinh token mới.
2. Admin: update `.env` `MCP_BEARER_TOKENS`, restart `mcp-semantic` + `mcp-vl`.
3. User: cập nhật token trong `claude_desktop_config.json` → full quit + reopen.

---

## Appendix B — Cursor / Continue.dev (optional)

Chưa officially support — cần TLS trước (Caddy Let's Encrypt hoặc cert nội bộ). Nếu có nhu cầu, báo admin.

---

## Support

- OpenWebUI issue → admin (docker logs openwebui + litellm-proxy).
- Claude Desktop crash → reinstall Claude Desktop / `npm install -g node@latest`.
- Token / access → admin.

**Đọc tiếp:** [onelog-team-project-guide.md](onelog-team-project-guide.md) — daily workflow qua workspace.
