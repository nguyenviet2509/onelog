# Phase 1 — Prep BookStack (bot user + token + ACL)

**Status:** pending
**Priority:** P0 (block phase 2)
**Effort:** ~30 min
**Owner:** admin KB.inet

## Mục tiêu

Chuẩn bị KB.inet để cấp API token cho bookstack-mcp truy cập read-only, giới hạn scope không thấy shelves nhạy cảm.

## Steps

1. **Đăng nhập** kb.inet.vn bằng account admin.
2. **Tạo user** `onemcp-bot@inet.vn` (Settings → Users → Add New User).
   - Role: **Viewer** (built-in) — chỉ view, không edit/create/delete.
   - Nếu chưa có Viewer built-in: tạo custom role `mcp-readonly` với permissions: `Access system API` + `View all books/chapters/pages`, KHÔNG bật create/update/delete.
3. **ACL**: (đã confirm KB kỹ thuật thuần, không cần exclude shelves) — SKIP.
4. **Tạo API token** (Edit bot user → API Tokens → Create Token).
   - Name: `onemcp-bridge-prod`
   - Expiry: 1 năm (đặt lịch renew calendar trước 30 ngày).
   - **Copy Token ID + Token Secret** ngay (secret chỉ hiện 1 lần).
5. **Lưu credential** vào password manager team + `.env` local (chưa deploy).
6. **Smoke test** từ máy dev — 3 query để audit KB size + VN diacritic:
   ```bash
   # a) Search 1 keyword có dấu VN
   curl -H "Authorization: Token TOKEN_ID:TOKEN_SECRET" \
        "https://kb.inet.vn/api/search?query=kh%E1%BA%AFc+ph%E1%BB%A5c&count=5"
   # b) Search cùng keyword bỏ dấu
   curl -H "Authorization: Token TOKEN_ID:TOKEN_SECRET" \
        "https://kb.inet.vn/api/search?query=khac+phuc&count=5"
   # c) List pages để đếm size
   curl -H "Authorization: Token TOKEN_ID:TOKEN_SECRET" \
        "https://kb.inet.vn/api/pages?count=1" | jq '.total'
   ```
   → Ghi lại vào `notes/kb-audit.md`: total page, có/không diacritic-fold, VN content ratio.
7. **Quyết định** dựa audit:
   - Nếu (a) và (b) ra kết quả khác nhau đáng kể → BookStack KHÔNG diacritic-fold → note vào Phase 4 prompt hint LLM thử 2 variant.
   - Nếu total >5000 → flag risk semantic search cho Phase 5 decision gate.

## Success criteria

- [ ] Bot user tồn tại, role read-only.
- [ ] API token hoạt động (curl 6a thành công).
- [ ] Audit KB size + diacritic behavior ghi vào `notes/kb-audit.md`.
- [ ] Credential lưu password manager + `.env.example` OneLog có dòng placeholder.

## Risks

- Token 1 năm hết hạn → tool im lặng fail. **Mitigate:** lịch calendar renew trước 30 ngày.
- BookStack không diacritic-fold VN → miss câu query khi user gõ có dấu vs không dấu khác nhau. **Mitigate:** step 7 phát hiện, Phase 4 handle.

## Deliverable

- Token ID + Secret (secure store).
- `notes/kb-audit.md` — total pages, diacritic behavior, VN ratio.
