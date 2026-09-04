# Brainstorm: OpenWebUI Filter — Warning emit + DB compact verification

**Session**: 260822-1046 · Asia/Saigon
**Trigger**: Sau khi verify Filter `trim-tool-history` fire OK qua 5 turn, user hỏi 2 câu open:
  1. `notification` event có work trong OpenWebUI 0.10.2 không, cần fallback `status` không?
  2. Chat dài có tự động compact khi member tiếp tục chat không?
**Decision**: Không code change. Giữ nguyên state hiện tại.

## Q1 — Notification event support

### Evidence conclusive

- `infra/openwebui/actions/onemcp-submit-kb.py:496` đã dùng `notification` event, đang chạy production
- Comment nguyên văn: `"Emit toast góc màn hình (OpenWebUI 0.10.x schema)"`
- Backend `socket/main.py:919` `get_event_emitter` emit tất cả event type tới FE socket, không lọc
- Không có branch xử lý `notification` trong backend (không persist DB) — nhưng FE 0.10.2 handle được (proven qua onemcp-submit-kb toast đang work)

### Decision

**Giữ nguyên `notification` only** trong `trim-tool-history.py`. Không cần fallback sang `status`.

### Trade-off đã accept

- `notification` = toast góc màn hình, tự tắt sau vài giây
- Nếu user không nhìn màn hình lúc toast emit → miss warning
- User chấp nhận trade-off này (đơn giản hơn combo notification + status)

### Signal mất warning

Nếu sau 1-2 tuần chạy prod, có user complain "chat crash không thấy cảnh báo trước" → revisit, đổi sang combo `notification + status` (đã có design sẵn).

## Q2 — DB compact behavior

### Verified state

Filter `trim-tool-history` compact **REQUEST layer only**, không compact DB:

| Layer | Behavior |
|---|---|
| Request tới LLM | ✅ Auto compact khi > 600k chars — drop oldest `tool` msgs |
| UI hiển thị chat | ❌ User vẫn thấy full history (từ DB) |
| DB `webui.db` | ❌ Không shrink — chat vẫn tích lũy raw |

### Working proof (log turn 3-5)

```
turn=3 before=102,864ch after=87,449ch  truncated=2 dropped=0
turn=4 before=124,799ch after=81,173ch  truncated=6 dropped=0
turn=5 before=158,238ch after=107,289ch truncated=7 dropped=0
```

Truncate đang fire (middle-cut tool outputs > 8k chars). Drop chưa fire vì chưa vượt 600k chars total — sẽ tự fire khi tokens tiếp tục tăng lên ~30+ turn tool-heavy.

### Decision

**Giữ nguyên hiện tại** — không thêm cron cleanup DB.

### Lý do (YAGNI)

- DB hiện 10MB total (49 chats), chat lớn nhất 6.1MB — không phải vấn đề disk
- Filter đã ngăn LLM crash context (điều quan trọng nhất)
- Compact DB = mất history UI = user bực khi mở lại chat cũ
- Chỉ đáng làm nếu DB > 500MB (< 1% khả năng)

### Trade-off đã accept

- Chat cũ (như "Kiểm Tra Host Mailer Shell" 6.1MB) vẫn giữ trong DB
- Khi user mở chat cũ và tiếp tục chat → Filter sẽ compact request tới LLM, nhưng lần load đầu hơi chậm (DB read 6MB)
- LLM có thể quên chi tiết turn rất cũ nếu bị drop → nhưng middle-cut giữ đầu+cuối, LLM vẫn nhận shape

## Approaches evaluated

| Option | Q1 emit | Q2 DB | Complexity | Trade-off |
|---|---|---|---|---|
| Chosen | notification only | keep as-is | Zero code change | Có thể miss toast, DB tăng chậm |
| Combo emit | notification + status hard | keep as-is | +10 lines code | Zero-miss warning, tốn +1 socket msg |
| Full aggressive | combo emit | + cron cleanup | +50 lines code + cron | Mất history UI, YAGNI vi phạm |

## Success metrics (đo trong 1-2 tuần)

- **Q1**: Zero user complain về missed warning → giữ notification only đúng call
- **Q2**: DB total < 100MB sau 1 tháng → không cần cron cleanup
- **Overall**: Zero ContextWindowExceededError trong OpenWebUI logs → Filter working end-to-end

## Follow-up khi có Gemini paid

Khi anh cấp Gemini paid API → cook Layer 1 (context_window_fallbacks) như đã brainstorm session 260822-0957. Combo Layer 1 + Layer 2 = 100+ turn deep-trace thoải mái.

## Unresolved

- Chưa test banner thực tế do chat mới ở 27k tokens (dưới SOFT_WARN 100k). Cần đợi user chat sâu tự nhiên trong 1-2 tuần để verify.
- Nếu OpenWebUI upgrade major version (0.11+) → FE handler cho `notification` có thể thay đổi. Follow-up test khi bump version image.
