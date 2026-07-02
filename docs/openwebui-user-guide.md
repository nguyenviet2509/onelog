# OpenWebUI — hướng dẫn user

> Audience: 5 ops engineers. Team chat UI thay Claude Desktop, chọn được model (Claude / Gemini / GPT / DeepSeek).
> URL: **http://webui.local/** (cần hosts entry — xem §1).

## 1. Chuẩn bị (1 lần / máy)

Thêm `webui.local` → `192.168.122.53`:

- **Windows** (PowerShell as Admin):
  ```powershell
  Add-Content -Path "$env:windir\System32\drivers\etc\hosts" -Value "192.168.122.53  webui.local"
  ```
- **macOS / Linux**:
  ```bash
  echo "192.168.122.53  webui.local" | sudo tee -a /etc/hosts
  ```

Verify: `ping webui.local` → reply từ `192.168.122.53`.

## 2. Đăng nhập lần đầu

- Admin gửi bạn: email + password tạm.
- Mở `http://webui.local/` → login → **đổi password ngay** (Settings → Account).
- Không bật signup public — chỉ admin invite được.

## 3. UI overview

```
┌──────────────────────────────────────────────────────────┐
│ [Sidebar]        │ [Chat pane]                           │
│  + New Chat      │  Model picker (dropdown top)          │
│  Workspaces      │  Message input                        │
│  Recent chats    │  Attach / MCP tools indicator         │
│                  │                                       │
│  Settings ⚙      │                                       │
└──────────────────────────────────────────────────────────┘
```

- **Model picker** (top): chọn model cho conversation. Đổi giữa chừng OK.
- **MCP tools icon** cạnh input: hiện list tool available (mcp-vl + mcp-semantic).
- **Workspaces** (sidebar): folder chứa chat — dùng thay Claude Project.

## 4. Chọn model theo tình huống

| Tình huống | Model gợi ý | Vì sao |
|---|---|---|
| Investigation phức tạp, cần tool-use nhiều bước | `claude-sonnet` | Tool-call fidelity tốt nhất, có prompt caching giảm cost |
| Query nhanh, câu ngắn, 1-2 tool call | `gemini-flash` | Rẻ nhất (~10x rẻ hơn Claude), latency thấp |
| VI reasoning dài, general Q&A | `gpt-4-mini` | Cân bằng cost/quality VI |
| Backup khi provider chính rate-limit | `deepseek` | Fallback rẻ, đủ dùng basic query |

**Mặc định:** `claude-sonnet` (an toàn). Đổi sang `gemini-flash` cho query đơn giản để tiết kiệm cost.

## 5. Dùng MCP tools

Không cần config — MCP đã wire sẵn qua admin. Chỉ hỏi tự nhiên:

- `mysql có lỗi gì trong 1 giờ qua không?` → model tự gọi `search_log_templates` / `query`.
- `Đếm số 502 theo host trong 30 phút qua` → tự gọi `stats_query`.
- `Tại sao service api-gateway chậm lúc 09:00?` → semantic search + LogsQL kết hợp.

Response chứa `[service:host:timestamp]` citation + `vmui_url` clickable → mở raw log.

**Tools available:**
- **onelog-vl** (~11 tool): `query`, `hits`, `facets`, `field_names`, `field_values`, `stream_field_names`, `stream_field_values`, `stream_ids`, `stats_query`, `stats_query_range`, `flags`
- **onelog-semantic** (1 tool): `search_log_templates`

## 6. Workspace / folder

Thay cho Claude Project `onelog-investigations`:

- Sidebar → **Workspaces** → **+ New workspace** → name: `onelog-investigations`.
- Move conversation vào workspace: click chat → right-click → Move to workspace.
- Share workspace: Settings → Members → add 5 ops emails.

Naming convention giữ nguyên:
- `[YYYY-MM-DD] <service> - <triệu chứng>`
- Vd: `[2026-07-15] mysql - connection pool exhausted`

## 7. Share conversation

- Click chat → menu **⋮** → **Share** → tạo link.
- Gửi Slack: `Đang trace vụ mysql: http://webui.local/s/<share-id>`
- Teammate mở link (cần cùng domain webui.local) → xem, có thể fork để tiếp tục điều tra riêng.

## 8. Cost visibility

Model picker hiển thị cost ước tính per-message. Sau chat:

- Settings → **Usage** → xem token count + cost tháng này (nếu admin đã enable).
- Query nào tốn nhiều token → model tự log, admin xem qua `/llm/spend/logs`.

## 9. Keyboard shortcuts

| Phím | Action |
|---|---|
| `Ctrl+K` (Cmd+K macOS) | Command palette |
| `Ctrl+/` | Toggle sidebar |
| `Ctrl+Shift+N` | New chat |
| `Ctrl+Enter` | Send message |
| `Esc` | Cancel streaming response |

## 10. Troubleshooting

| Triệu chứng | Fix |
|---|---|
| `webui.local` không mở | `ping webui.local` — nếu fail, redo §1 hosts entry |
| "Failed to connect to backend" | LiteLLM down — báo admin `docker compose ps litellm-proxy` |
| Model list rỗng | Virtual key hết budget hoặc admin chưa cấp — báo admin |
| Tool không được gọi (model chỉ trả text) | Chuyển model `claude-sonnet` (tool-use tốt hơn); hoặc phrase câu hỏi rõ hơn |
| Chat load chậm, timeout | Provider rate-limit — refresh, đổi sang model khác |
| Citation `vmui_url` không mở | Cần thêm `app.local` vào hosts (xem [mcp-setup-guide.md](mcp-setup-guide.md) Appendix A §2) |
| Password quên | Báo admin reset qua CLI |

## 11. Privacy

- Chat visible cho member cùng workspace — **không paste secret / credential**.
- Chat history lưu server-side, backup daily encrypted (age).
- Provider API (Anthropic/OpenAI/Google) có ToS riêng — assume không train trên enterprise API traffic nhưng vẫn không paste sensitive PII.

## Support

- UI issue → admin (docker logs openwebui).
- Model không trả về / tool call fail → thử model khác trước, sau đó báo admin.
- Access → admin.

Xem tiếp: [onelog-team-project-guide.md](onelog-team-project-guide.md) — daily workflow.
