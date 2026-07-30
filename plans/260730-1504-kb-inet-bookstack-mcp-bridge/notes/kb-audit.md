# KB.inet audit — 2026-07-30 15:52

## Size
- **Total pages: 375** (từ `/api/pages?count=1` → `total`)
- Nhỏ → BookStack MySQL FULLTEXT dư sức. Không cần semantic mirror.
- Non-goal RAG mirror trong plan.md xác nhận đúng.

## Diacritic behavior
- Query `khắc phục` → page ID 959 (top result)
- Query `khac phuc` → **same page ID 959** (top result)
- **BookStack CÓ diacritic-fold** (MySQL utf8mb4_unicode_ci hoặc collation tương tự)
- Impact: Rule 4 (diacritic variant) trong system prompt **không cần thiết**, có thể để defensive fallback (không hại)

## KB freshness
- Page 959 update 2026-05-10 → KB đang được maintain.

## Search API sanity
- Response shape khớp bookstack-mcp expectation: `data[].{name,url,preview_html,updated_at}` present.
- API version compat: OK (BookStack v25.x infer từ page structure).

## Security note
- ⚠️ Token gốc user paste public trong chat 2026-07-30 15:51 → **cần revoke + tạo lại** trước khi cấu hình VPS production.
- Token hiện tại KHÔNG lưu vào bất kỳ file nào của repo.

## Decision impacts

| Rule | Quyết định |
|---|---|
| Rule 4 diacritic trong prompt | Giữ defensive (không hại, edge case có thể tồn tại) |
| Semantic RAG (hướng C brainstorm) | KHÔNG cần, KB nhỏ |
| Cache 60s (nếu p95 >2s ở phase 5) | Chưa cần, monitor sau |
| Proxy trong OneMCP (nếu tool bloat) | Chưa cần, monitor sau |
