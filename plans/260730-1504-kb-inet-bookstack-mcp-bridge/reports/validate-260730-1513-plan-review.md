# Validation Report — kb-inet-bookstack-mcp-bridge

Date: 2026-07-30 15:13
Reviewer: /ck:plan validate

## Câu hỏi đã đặt & câu trả lời

| # | Q | A |
|---|---|---|
| 1 | OpenWebUI ↔ OneMCP wiring? | Chưa biết → scout ngay |
| 2 | KB size + VN diacritic ratio? | Chưa biết chính xác |
| 3 | Có shelves nhạy cảm? | Không, KB kỹ thuật thuần |
| 4 | System prompt quản lý ở đâu? | Per-model config trong UI OpenWebUI |

## Scout findings (Q1)

File `infra/openwebui/mcp-config.json` đang mount vào OpenWebUI:
- 2 MCP server đã đăng ký: `onelog-vl` (mcp-vl:8000) + `onelog-semantic` (mcp-semantic:9000)
- Transport = `streamable-http` với `Authorization: Bearer ${MCP_TOKEN_OPENWEBUI}`
- Reachable qua docker internal network, **không đi qua Caddy**

**Hệ quả cho plan:**
- ✅ Phase 4 giả định "OpenWebUI native MCP" **ĐÚNG**
- ❌ Phase 4 sai chỗ: mô tả "add qua UI Settings → Tools → MCP Servers" — thực tế là **edit file `mcp-config.json` + version control**
- ❌ Phase 3 (Caddy route) **thừa** — bookstack-mcp chạy cùng docker network, OpenWebUI gọi trực tiếp `http://bookstack-mcp:8080/mcp`, không cần expose ra ngoài. Chỉ cần expose nếu có client external.
- ✅ OneMCP artifact search KHÔNG được register trong OpenWebUI MCP client — action Python (`onemcp-submit-kb.py`) mới nói chuyện với `/api/mcp` OneMCP. → **Kỳ vọng "LLM tự route giữa OneMCP artifacts vs KB" ở Phase 4 SAI**: chat LLM chỉ thấy tool của `mcp-vl` + `mcp-semantic` + `bookstack` (nếu add). Muốn LLM search OneMCP artifact phải add OneMCP vào `mcp-config.json` (chưa có).

## Gaps & required changes

### Gap 1 — Kỳ vọng "route giữa 2 hệ" không đúng thực tế
Chat OpenWebUI hiện KHÔNG có tool tìm artifact OneMCP. Toàn bộ Phase 4 system prompt viết về "route giữa OneMCP artifacts và KB.inet" là **premature**.

**Fix**: chọn 1 trong 2 hướng:
- **A.** Giới hạn scope plan này = **chỉ add KB.inet**. Bỏ toàn bộ mô tả "route OneMCP artifacts". Prompt phase 4 chỉ nói về KB. Việc register OneMCP MCP client là plan riêng.
- **B.** Mở rộng plan: thêm phase register OneMCP artifacts search vào `mcp-config.json` cùng lúc.

Recommend **A** (KISS). User yêu cầu tích hợp KB → đúng scope. OneMCP-in-chat để plan riêng.

### Gap 2 — Phase 3 (Caddy) không cần cho MVP
OpenWebUI gọi trực tiếp container qua docker network. Caddy route chỉ cần nếu:
- Test từ máy dev external
- Client khác (Claude Desktop) muốn dùng

**Fix**: Move Phase 3 thành **optional/deferred**, hoặc gộp vào Phase 5 (nếu smoke test cần external access).

### Gap 3 — KB size unknown → risk semantic search
Không biết KB có bao nhiêu page + tỷ lệ VN. BookStack MySQL FULLTEXT với VN có dấu **thường OK** (v25.x support UTF-8 mb4), nhưng cần smoke test thực tế.

**Fix**: Add step "audit KB size + query VN có dấu" vào Phase 1 (5 phút chạy 3 curl). Nếu miss diacritic → thêm prompt hint LLM thử cả 2 variant.

### Gap 4 — ACL đơn giản hoá
Không có shelves nhạy cảm → **bỏ toàn bộ step exclude shelves** ở Phase 1. Bot user Viewer role default là đủ. Tiết kiệm 15 phút.

### Gap 5 — System prompt in UI = no version control
User confirm prompt manage in OpenWebUI UI per-model. → risk: prompt bị đổi mà không ai biết.

**Fix**: Phase 4 thêm step "copy prompt cuối cùng vào `docs/openwebui-kb-routing.md`" làm backup + lịch review quarterly.

## Rủi ro plan không xử lý (mới phát hiện)

| Risk | Impact | Xử lý |
|---|---|---|
| OneMCP artifacts KHÔNG có trong OpenWebUI chat context | Phase 4 prompt "route" hoạt động sai | Fix Gap 1 (scope A) |
| bookstack-mcp container name conflict với `bookstack` (BookStack self-host?) | Container start fail | Verify `docker ps` trước Phase 2, không có service tên `bookstack` |
| `MCP_TOKEN_OPENWEBUI` không apply cho bookstack-mcp (bookstack-mcp không check bearer) | bookstack endpoint open trong docker network | OK vì internal network + write=false; document là "trust boundary = docker network" |

## Verdict

**Plan cần update trước khi cook**:
1. **Phase 1**: bỏ ACL exclusion, add "audit KB size + VN diacritic smoke curl".
2. **Phase 3**: mark optional/deferred (docker internal network đủ cho MVP).
3. **Phase 4**: 
   - Sửa "add via UI" → **edit `mcp-config.json`**.
   - Thu hẹp scope prompt: **chỉ KB.inet**, bỏ mô tả OneMCP artifact routing.
   - Add step backup prompt vào `docs/`.
4. **Phase 5**: 
   - Bỏ metric "route giữa 2 nguồn".
   - Add smoke test diacritic-fold (query "khac phuc" vs "khắc phục").
5. Plan file `plan.md`: cập nhật Risk matrix (bỏ hàng "route conflict") + non-goals (thêm "không register OneMCP MCP client — plan riêng").

## Unresolved

- Có nên gộp plan register OneMCP MCP client cùng plan này không? → Recommend riêng, YAGNI cho user story hiện tại.
- OpenWebUI có support hot-reload `mcp-config.json` không? Có thể phải restart OpenWebUI container sau khi add bookstack. → Verify khi cook Phase 4.
