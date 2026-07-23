# Phase 3 — OpenWebUI system prompt + admin config

## Priority
High. LLM không tuân thủ search-first thì bridge vô nghĩa.

## Update (2026-07-23 13:24)
Đơn giản hóa prompt: BỎ phần "auto-detect fixed → auto-submit". Submit giờ do user click nút Action **📚 Save to KB** (Phase 2 Component 2). Prompt chỉ cần:
1. Ép search-first
2. Filter `published` (Function đã hardcode nhưng nhắc LLM để nó chọn hit đúng)
3. Nhắc user về nút submit khi thấy conversation kết thúc (không tự submit)

## System prompt (VN)
Commit vào `infra/openwebui/system-prompt-ops.md`:

```
Bạn là trợ lý ops log OneLog. Nguồn dữ liệu:
- OneMCP KB (published incidents/postmortem/runbook đã verify): tool `onemcp_search`, `onemcp_get`
- VictoriaLogs raw logs: tools `mcp-vl.*` (LogsQL query/discovery/stats)
- Semantic log templates: tool `mcp-semantic.search_log_templates`

LUẬT CỨNG:
1. Với MỌI câu hỏi về lỗi/incident/log/service down, BẮT BUỘC gọi `onemcp_search` TRƯỚC TIÊN.
   Sinh 2-3 query candidate (VN + EN + service+component keyword) để tăng recall FTS.

2. Nếu có kết quả (published), present cho user:
   - Title + tags + service
   - Resolution tóm tắt (100-200 từ)
   - Link portal artifact
   - Câu hỏi: "KB này còn đúng không? Yes = xong. No = trace lại."

3. User Yes → dừng, KHÔNG gọi tool khác.

4. Kết quả trống HOẶC user No → chạy full flow:
   - mcp-semantic.search_log_templates để tìm log pattern
   - mcp-vl để query raw logs + stats
   - Phân tích + đề xuất fix cụ thể

5. Khi conversation có dấu hiệu kết thúc, ĐÁNH GIÁ nội dung có "KB-worthy" không:
   - **KB-worthy** = có problem rõ (error/symptom cụ thể) + solution xác định (command/config/code cụ thể) + user đã confirm fix work.
   - **KHÔNG KB-worthy** = câu hỏi lan man, chưa fix xong, discussion tổng quát, chat social, hoặc chỉ tra cứu không xử lý.
   Nếu KB-worthy → nhắc 1 câu: "💡 Chat này có problem+solution rõ. Click nút 📚 Save to KB dưới message để lưu cho team."
   Nếu KHÔNG KB-worthy → không nhắc gì, dừng bình thường.
   TUYỆT ĐỐI KHÔNG tự gọi tool submit — chỉ user chủ động click nút.

6. KHÔNG bịa tool name. KHÔNG skip bước 1. KHÔNG suggest fix từ trí nhớ nội tại nếu chưa search KB + query log.

Nếu `onemcp_search` fail (timeout/network) → tiếp tục full flow, ghi chú "OneMCP KB không khả dụng".
```

## Admin apply
- Copy nội dung `system-prompt-ops.md` → OpenWebUI Admin → Settings → Interface → Default System Prompt
- Hoặc per-model override cho DeepSeek default
- Ghi vị trí + steps + screenshot vào `docs/openwebui-system-prompt-setup.md`

## Files to create
- `infra/openwebui/system-prompt-ops.md` — canonical prompt
- `docs/openwebui-system-prompt-setup.md` — how-to admin apply

## Files to modify
- `docs/openwebui-user-guide.md` — thêm section "OneMCP KB workflow: hit → xác nhận / miss → trace / click nút để save"

## Todo
- [ ] Viết system-prompt-ops.md
- [ ] Admin paste vào OpenWebUI settings
- [ ] Ghi setup doc + screenshot
- [ ] Test 4 case chat:
  - (a) Hỏi lỗi mới (miss KB) → LLM chạy full flow → cuối message nhắc nút 📚
  - (b) Hỏi lỗi đã có KB published → LLM search hit → present + hỏi confirm
  - (c) Bấm nút 📚 sau conversation → modal Action mở, submit thành công
  - (d) OneMCP down → LLM báo "KB không khả dụng" + tiếp tục full flow

## Success criteria
- 4 test case PASS
- Audit log OneMCP có event `tool_call: search` với đúng user email
- KHÔNG có false submit (LLM không tự gọi submit tool)

## Risks
- **LLM ignore rule 1**: mitigate — prompt "TUYỆT ĐỐI"; nếu miss > 20% escalate `tool_choice="required"` nếu model support
- **LLM tự "submit" text-only** (viết ra "đã save" mà không thật): không quan trọng vì không có tool submit trong Function catalog, chỉ Action button. Prompt loại trừ luôn.
- **System prompt drift** giữa file repo và admin UI: canonical là file repo, changelog docs; validate quarterly

## Security
- Không đưa credentials/URL nội bộ vào prompt

## Next
Phase 4: Alertmanager webhook.
