# Phase 4 — OpenWebUI wire-up + routing intelligence

**Status:** pending
**Priority:** P0 (đây là phase xử lý toàn bộ Risk brainstorm)
**Effort:** ~2h
**Depends on:** Phase 3

## Mục tiêu

Kết nối OpenWebUI với `bookstack-mcp` (endpoint thứ 2, ngoài OneMCP), cấu hình system prompt để LLM route đúng, xử lý toàn bộ Risk đã nêu trong brainstorm.

## Files to modify

- `d:\Vietnt\Project\onelog\infra\mcpo\config.template.json` — add upstream `bookstack` (DONE ở cook).
- `d:\Vietnt\Project\onelog\infra\docker-compose.yml` — add service `bookstack-mcp` + mcpo depends_on + healthcheck (DONE ở cook).
- `d:\Vietnt\Project\onelog\infra\.env.example` — add `KB_INET_*` (DONE ở cook).
- OpenWebUI Admin → Tools → register `http://mcpo:8080/bookstack` (manual UI step trên VPS).
- OpenWebUI Workspace → Models → System Prompt (manual UI, copy từ `docs/openwebui-kb-routing.md`).
- `d:\Vietnt\Project\onelog\docs\openwebui-kb-routing.md` — doc + backup prompt (DONE ở cook).

## Scope clarification (từ validation)

Plan này CHỈ thêm KB.inet. OneMCP artifact search hiện **CHƯA** register trong OpenWebUI MCP client (`mcp-config.json` chỉ có `onelog-vl` + `onelog-semantic`). Prompt phase này KHÔNG viết logic "route giữa OneMCP artifacts vs KB" — chỉ hướng dẫn LLM dùng bookstack tools đúng cách, phối hợp với `onelog-vl` + `onelog-semantic` đã có.

Việc add OneMCP artifact search vào chat = plan riêng, out of scope.

## 4.1 Wiring (đã config, deploy step)

**Correction từ scout Cook**: OpenWebUI **KHÔNG native MCP**. Wiring thật:

```
OpenWebUI (OpenAPI) → mcpo (MCP proxy) → bookstack-mcp → kb.inet.vn
```

File đã update local:
- `infra/mcpo/config.template.json` — thêm upstream `bookstack` (URL `http://bookstack-mcp:8080/mcp`)
- `infra/docker-compose.yml` — service `bookstack-mcp` + mcpo depends_on + healthcheck path `bookstack`
- `infra/.env.example` — placeholder `KB_INET_*`

Deploy trên VPS (host-sync-policy):
1. Local commit + push origin/master.
2. SSH `onelog-vps` → `cd /opt/onelog` → `git pull`.
3. Set `KB_INET_TOKEN_ID` + `KB_INET_TOKEN_SECRET` trong `/opt/onelog/infra/.env` (từ token Phase 1).
4. `docker compose --profile chat up -d bookstack-mcp` → wait healthy.
5. `docker compose --profile chat up -d --force-recreate mcpo` (re-discover tools).
6. `docker compose --profile chat restart openwebui` (pick up new mcpo endpoint).
7. Verify: `curl http://127.0.0.1:8091/bookstack/openapi.json` từ VPS → phải liệt kê ~20 tool.

## 4.2 Register bookstack endpoint trong OpenWebUI (manual UI)

Login OpenWebUI Admin → Settings → Tools → + Add Connection:
- URL: `http://mcpo:8080/bookstack`
- Auth: Bearer `${MCPO_API_KEY}`
- Name: `bookstack`

Hoặc set qua env `TOOL_SERVER_CONNECTIONS` (JSON array) — gộp với các entry hiện có.

Verify: mở chat mới → tool list phải hiện `bookstack__search_pages`, etc.

## 4.2 System prompt (bản engineering)

Áp cho model của team kỹ thuật (OpenWebUI → Workspace → Models → chọn model → System Prompt).

**Sau khi lưu prompt cuối, copy nội dung sang `docs/openwebui-kb-routing.md` để backup + version control (prompt trong UI không có history).**

```markdown
# Trợ lý kỹ thuật iNET

Bạn là trợ lý kỹ thuật cho phòng kỹ thuật iNET. Bạn có các nhóm tool:

## Nhóm log — `onelog-vl__*`
Query log server (VictoriaLogs). Dùng khi user hỏi về log, error trace, request cụ thể.

## Nhóm semantic — `onelog-semantic__*`
Semantic search log/context nội bộ. Dùng khi cần tìm log theo ý nghĩa, không phải keyword.

## Nhóm KB.inet — `bookstack__*` (MỚI)
Tài liệu chuẩn hoá trên KB.inet (BookStack):
- Hướng dẫn kỹ thuật, quy trình vận hành (SOP)
- Runbook lỗi có tên rõ ràng
- Cấu hình sản phẩm iNET: OnePanel, cPanel, MikroTik, Zimbra, ESXi, Jetbackup, ...

## Nguyên tắc routing KB.inet (BẮT BUỘC)

1. **Whitelist tool KB được phép dùng** (dù bookstack expose ~20 tool):
   - `bookstack__search_pages` — tìm
   - `bookstack__get_page` — đọc nội dung
   - `bookstack__get_recent_changes` — "KB có gì mới"
   - KHÔNG được gọi: `bookstack__export_*`, `bookstack__get_books`, `bookstack__get_shelves`, `bookstack__get_attachments`, `bookstack__get_comments`, `bookstack__find_users`, `bookstack__get_recycle_bin`, hoặc bất kỳ `create_*`/`update_*`/`delete_*` (write đã disable, nhưng vẫn cấm).

2. **Khi nào gọi KB**:
   - Câu hỏi "how-to" / "cách làm" / tên lỗi / tên sản phẩm iNET.
   - Câu hỏi tra cứu SOP, runbook.
   - Câu "trong KB có tài liệu gì về X" → forced KB.

3. **Cite source LUÔN**: kết quả từ KB → cite link `https://kb.inet.vn/...` (từ field `url` trong response).

4. **Diacritic handling** (nếu Phase 1 audit thấy BookStack không diacritic-fold):
   - Nếu query VN có dấu ra ít kết quả → thử lại query bỏ dấu.
   - VD `search_pages("khắc phục 502")` empty → thử `search_pages("khac phuc 502")`.

5. **Xử lý tool error / down**:
   - Nếu `bookstack__*` fail (timeout / 5xx) → tiếp tục trả lời từ kiến thức chung + log/semantic tools, note cuối reply:
     `"⚠️ KB.inet tạm không truy cập được."`
   - Không crash chat, không retry vô hạn.

6. **Empty result KB**:
   - Trả lời từ kiến thức chung + note: `"Không tìm thấy trong KB.inet. Đây là câu trả lời dựa kiến thức chung, chưa được team xác nhận."`

7. **Kết hợp KB + log tools**:
   - VD user hỏi "502 fleet, cách xử lý?" → gọi `onelog-vl` tìm trace + `bookstack__search_pages` tìm runbook → gộp trong reply với 2 nhãn:
     - `**📘 Runbook (KB.inet):**`
     - `**🔍 Log gần nhất:**`
   - Nếu conflict info → ưu tiên nguồn có timestamp mới hơn.

## Ví dụ nhanh

- "Cách cài OnePanel" → `bookstack__search_pages("OnePanel cài đặt")` → get_page → cite.
- "Tìm trong KB xem có Jetbackup không" → chỉ `bookstack__search_pages("Jetbackup")`.
- "KB có gì mới tuần này" → `bookstack__get_recent_changes`.
- "Log 502 site X + cách fix" → `onelog-vl__query` + `bookstack__search_pages("502")`.
```

## 4.3 Risk mitigation matrix (xử lý trong system prompt trên)

| Risk (từ brainstorm + validation) | Xử lý cụ thể trong prompt |
|---|---|
| Tool bloat (20 tools KB) | Rule 1: whitelist 3 tool, cấm gọi các tool khác |
| KB cũ vs log/context mới → cite sai | Rule 7: ưu tiên timestamp mới, note conflict |
| Câu ambiguous (SOP + log) | Rule 7: 2 label `📘 Runbook (KB)` / `🔍 Log gần nhất` |
| User mất niềm tin khi KB down | Rule 5: graceful fallback + warning banner |
| Empty KB | Rule 6: note "chưa được team xác nhận" |
| VN diacritic mismatch (nếu audit phát hiện) | Rule 4: thử 2 variant có/không dấu |
| LLM gọi write tool nguy hiểm | Rule 1 whitelist + bookstack `ENABLE_WRITE=false` (defense in depth) |

## 4.4 Doc onboard team (1 slide)

Tạo `d:\Vietnt\Project\onelog\docs\openwebui-kb-routing.md`:

```markdown
# Cách chat với trợ lý kỹ thuật iNET (KB.inet + OneMCP)

## TL;DR
Cứ hỏi tự nhiên. Trợ lý tự chọn nguồn.

## 2 nguồn (tự động)
- **KB.inet** — SOP, hướng dẫn, cấu hình sản phẩm (OnePanel, cPanel, MikroTik...)
- **OneMCP** — Việc team đã/đang làm (incident, cook result, artifact)

## Ép chọn nguồn (nếu cần)
- "Tìm trong KB..." → chỉ KB
- "Có artifact nào về..." → chỉ OneMCP

## Nếu 1 hệ down
Trợ lý báo trong reply, kết quả từ hệ còn lại.

## Report vấn đề
Ping @chuongdt hoặc submit qua wrapup.
```

## Success criteria

- [ ] OpenWebUI list được tool bookstack (search_pages, get_page, get_recent_changes).
- [ ] 5 test query mẫu (phase 5) route đúng nguồn.
- [ ] LLM KHÔNG gọi tool ngoài whitelist (verify qua OpenWebUI log 1 tuần).
- [ ] Doc onboard 1-page được share cho team.

## Risks còn lại

- LLM ignore system prompt → gọi tool ngoài whitelist. **Mitigate:** phase 5 monitor, nếu > 10% call ngoài whitelist → cân nhắc "cách 3 proxy" (deferred plan).
- User quen giao diện cũ, không biết KB đã hook AI. **Mitigate:** announce ở kênh team + demo 5 phút.
