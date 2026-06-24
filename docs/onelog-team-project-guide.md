# Onelog — Claude Team Project workflow guide

> Audience: 5 ops engineers đã setup MCP xong (xem [mcp-setup-guide.md](mcp-setup-guide.md)).
> Mục tiêu: investigation knowledge **shared tự động** giữa 5 ops thay vì mỗi người hỏi lại từ đầu.

## 1. Vì sao dùng Project (không chat personal)

| Personal chat (default Claude Desktop) | Project `onelog-investigations` |
|---|---|
| Chỉ bạn xem được | 5 ops member đều xem được |
| Không search được conversation cũ của teammate | Search được full text trong Project |
| Claude không biết investigation cũ của đồng nghiệp | Project system prompt + shared history giúp Claude tham chiếu |
| Member 2 phải hỏi lại lỗi member 1 đã điều tra | Member 2 mở Project → search "mysql" → đọc conversation cũ |

→ **Quy tắc:** log investigation = trong Project. Personal chat dành cho việc cá nhân (code Q&A, learning).

## 2. Vào Project

1. Mở Claude Desktop (hoặc claude.ai web)
2. Sidebar trái → **Projects**
3. Click **`onelog-investigations`**
4. **"+ New chat"** trong Project (chứ không phải "+ New chat" ở sidebar gốc — cái đó là personal)

Verify đã ở trong Project: tiêu đề trên cùng cửa sổ chat hiển thị tên Project, không phải "Claude".

## 3. Naming convention conversation

**Format:** `[YYYY-MM-DD] <service> - <triệu chứng>`

**Vd tốt:**
- `[2026-06-24] mysql - connection pool exhausted`
- `[2026-06-24] nginx - 502 burst lúc 14:30`
- `[2026-06-25] redis - OOM killed sau ETL job`
- `[2026-06-25] api-gateway - latency p99 tăng 3x từ 09:00`

**Vd KHÔNG dùng:**
- ❌ `test` / `alo` / `?` — không tìm lại được
- ❌ `chuyện gì xảy ra` — không có service/keyword
- ❌ `urgent fix` — không có context

Claude Desktop tự đặt tên dựa trên message đầu — bạn **rename ngay** sau message đầu bằng cách click vào tiêu đề conversation.

## 4. Workflow điều tra incident

### A. Trước khi hỏi Claude — search Project

1. Project sidebar có ô search → gõ keyword (vd `mysql`, `502`, `redis`)
2. Scan list conversation gần đây
3. **Nếu thấy case tương tự < 30 ngày:**
   - Đọc conclusion + fix
   - Apply fix tương ứng (nếu cùng nguyên nhân)
   - Hoặc reply trong conversation cũ nếu cần expand context
4. **Nếu không tìm thấy:** mở conversation mới

→ Tiết kiệm tokens + thời gian. Tránh duplicate effort.

### B. Tạo conversation mới

1. Click "+ New chat" trong Project
2. Đặt câu hỏi tự nhiên, vd:
   - `mysql có lỗi gì trong 1 giờ qua không?`
   - `Tại sao service api-gateway chậm bất thường lúc 09:00?`
   - `Có template log error nào về connection refused gần đây?`
3. Claude sẽ gọi tool MCP phù hợp:
   - **Fuzzy intent** ("vì sao", "có vấn đề gì") → `search_log_templates` (semantic)
   - **Precise filter** ("service=X AND time>...") → `query` / `hits` / `stats_query` của mcp-vl
4. Response có `[service:host:timestamp]` citation + `vmui_url` clickable → click để xem raw log

### C. Sau khi tìm ra root cause

1. **Rename conversation** theo format `[YYYY-MM-DD] <service> - <triệu chứng>`
2. Trong tin nhắn cuối, summarize ngắn:
   ```
   ## Root cause
   - <1-2 dòng>

   ## Fix applied
   - <bullet list>

   ## Prevention
   - <nếu có>
   ```
3. Nếu fix lâu dài → thêm vào `docs/runbooks/<service>.md` trong git repo (weekly review do ops trực phụ trách)

## 5. Khi nào KHÔNG dùng Project

| Trường hợp | Channel đúng |
|---|---|
| Hỏi Claude về code Python/Go nói chung | Personal chat |
| Code review, refactor suggestion | Personal chat hoặc Claude Code |
| Learn 1 concept (Kubernetes, Postgres tuning) | Personal chat |
| Brainstorm idea mới chưa liên quan log | Personal chat |
| Sensitive context cá nhân (vd debug code chưa commit) | Personal chat |
| **Bất cứ thứ gì liên quan production log của onelog** | **Project** |

## 6. Share workflow giữa team

### Real-time
- Member 1 đang điều tra → tag member 2 trong Slack: `Đang trace vụ mysql connection pool, xem conversation [link claude.ai/projects/onelog-investigations/...]`
- Member 2 click link → vào Project → reply trong conversation đó để collab

### Async / sau giờ
- Mỗi conversation tự visible cho 5 ops khi ai đó mở Project
- Daily standup: scan 5 conversation gần nhất, ai có pending → xử lý
- Weekly review (Thứ 6): ops trực extract highlight → `docs/runbooks/*`

## 7. Privacy + audit

- **Tất cả conversation trong Project = visible cho 5 member.** Đừng paste secret / credential vào chat.
- Server-side audit: mỗi tool call ghi vào `/var/log/onelog-audit/mcp-semantic.log` với `user`, `tool`, `query`, `result_size`
- Admin có thể grep audit để biết ai gọi gì khi nào
- Claude Anthropic không train trên conversation của Team plan (per Anthropic ToS)

## 8. FAQ

**Q: Lỡ tạo conversation log investigation ở personal chat, làm sao move vào Project?**
A: Hiện Claude Desktop chưa support move conversation. Workaround: copy conversation text → tạo conversation mới trong Project paste vào.

**Q: Project có limit số conversation?**
A: Không cứng. Theo dõi nếu list dài, sort theo "Recently updated" để focus.

**Q: 2 member cùng mở 1 conversation chat song song?**
A: Hỗ trợ. Claude Desktop sync real-time. Nhưng tránh đua message — đợi reply trước khi gửi tiếp.

**Q: Member rời team, conversation của họ?**
A: Stay trong Project. Admin remove member khỏi workspace → họ mất access, history còn.

**Q: Search không tìm được conversation rõ ràng đã có?**
A: Claude.ai search text-based, không semantic. Đảm bảo conversation có keyword cụ thể (rename đúng format). Hoặc dùng browser Ctrl+F trên list.

## Next steps after onboarding

- [ ] Tham gia 30 phút meeting onboarding cùng admin
- [ ] Smoke test 1 query thật (vd "show last 10 error logs")
- [ ] Bookmark Project URL trong browser
- [ ] Tuần đầu: tạo ≥1 conversation thật trong Project để tập workflow
