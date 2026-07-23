# Seed KB drafts

Rút từ `plans/reports/vps-*.sh` + `journal-*` + `audit-*` để publish trước go-live.

**Cách import:**
1. Review từng file draft dưới (edit nếu cần)
2. Vào portal OneMCP (https://192.168.122.56)
3. **+ New Artifact** → type = `kb` → paste `title`, `problem`, `solution`, `tags`
4. Save → mặc định `pending` → maintainer publish
5. Verify: từ chat OpenWebUI hỏi keyword trong title → `onemcp_search` hit

## Đã tạo (starter set — user mở rộng lên 15-25 covering 6-8 services)

- `kb-01-litellm-deepseek-fallback.md` — LiteLLM cost dashboard fallback
- `kb-02-victoriametrics-scrape-flag.md` — VM scrape env-expansion pitfall
- `kb-03-mcpo-tools-empty-openapi.md` — mcpo restart when 0 tools discovered
- `kb-04-nats-jetstream-unhealthy.md` — NATS jetstream health false-alarm
- `kb-05-caddy-openwebui-routing.md` — Caddy path routing cho OpenWebUI subpath

**Còn thiếu** (user tự extract từ reports còn lại):
- nginx 502 upstream — nếu có case thật trong journal
- rsyslog forwarder mTLS cert expire
- Qdrant collection dimension mismatch
- Vector redact regex false positive
- Postgres OOM khi indexer batch quá lớn
- (khoảng 10 case nữa cho đủ 15-25)

## Naming
`kb-NN-<slug>.md` — số + slug ngắn. NN từ 01. Slug lowercase kebab.
