# Phase 5 — Smoke test end-to-end + docs update

## Priority
High. Không có smoke = không biết bridge có work thật cho team.

## Requirements

### Smoke test scenarios (chạy theo thứ tự)
1. **Seed trước**: manual submit 5-10 published entries vào OneMCP portal (topic thật của team: nginx, php-fpm, redis, postgres...). Cần thiết trước go-live để tránh cold-start.
2. **Save qua nút Action**: mở OpenWebUI, chat trace 1 lỗi mới (ví dụ redis latency). LLM chạy full flow xong → click nút **📚 Save to KB** dưới message cuối → modal hiện với draft title/body/tags → edit → confirm → verify entry pending trong OneMCP portal với **contributor = user email thật** (không phải bot).
3. **Verify manual**: maintainer vào portal review entry pending → publish → status=published.
4. **Hit query**: chat mới, hỏi câu related tới entry đã publish → LLM gọi `onemcp_search` → hit published → present resolution + hỏi confirm.
5. **Synonym miss test**: hỏi variant với keyword khác hoàn toàn → check multi-query trong prompt Phase 3 có sinh candidate không → hit hay miss → ghi lại vào baseline metric.
6. **Full flow fallback**: hỏi lỗi mới hoàn toàn → search miss → LLM chạy mcp-vl + mcp-semantic → cuối message nhắc nút 📚 (không tự submit).
7. **Identity verification**: audit log OneMCP show đúng user email (2 users khác nhau login OpenWebUI → 2 users khác nhau trong audit).
8. **OneMCP down test**: stop OneMCP → chat vẫn work, LLM báo "OneMCP không khả dụng" + full flow chạy bình thường.
9. **Alertmanager**: manual fire 1 alert critical → verify webhook OneMCP nhận + (optional) runbook link trong Slack/Telegram.

### Docs updates
- **`README.md`** — service table thêm dòng "OneMCP KB (external)"; section Documentation link tới guide bridge
- **`docs/deployment-guide.md`** — thêm env vars `ONEMCP_URL`, `ONEMCP_BOT_USER`, `ONEMCP_ALERT_WEBHOOK_TOKEN`; section "Prerequisites: OneMCP must be reachable"
- **`docs/mcp-setup-guide.md`** — thêm section OneMCP endpoint discovery URL (nếu Path A) hoặc Function install steps (nếu Path B)
- **`docs/openwebui-user-guide.md`** — flow diagram: khi nào cache hit / khi nào full trace / cách submit KB
- **`docs/kb-workflow.md` (new)** — team-facing: khi nào trust cached, cách submit tốt (title concise, body sections chuẩn), verify workflow (link portal OneMCP)
- **`mockups/onelog-services-detail.html`** — update per `update-services-detail` skill rule
- **`mockups/onelog-system-explainer.html`** — update topology thêm OneMCP box + arrow

### Seed 15-25 published entries (BLOCKING gate — V4 updated 2026-07-23)
Cover 6-8 core services của OneLog: nginx, redis, postgres, php-fpm, victorialogs, vector, indexer, litellm/openwebui, qdrant, caddy. Mỗi service 2-3 entries.
Nguồn candidate đã xác định trong OneLog `plans/reports/`:
- `audit-260710-0854-prod-readiness-full.md` — rút 1-2 issue prod đã fix
- `audit-260713-0815-plan-vs-runtime-gaps.md` — runtime gaps + resolutions
- `audit-260713-1017-storage-decom-and-silent-pipeline-regression.md` — real silent regression case
- `pre-prod-gap-260624-1327-mcp-only-rollout.md` — gap+fix
- `vps-fix-grafana-dashboard.sh` — Grafana fix
- `vps-fix-vm-and-qdrant-scrape.sh` — VM+Qdrant scrape fix
- `vps-patch-caddy-openwebui.sh` — Caddy patch
- `vps-patch-litellm-fallback.sh` — LiteLLM fallback
- Chọn 5-10 case có: (a) triệu chứng rõ, (b) root cause xác định, (c) fix cụ thể, (d) verify command

Workflow:
1. Claude quét từng file trên → extract {title, symptom, root_cause, fix, verify} → markdown draft KB entries
2. Commit vào `plans/260723-1200-onemcp-openwebui-bridge/seed-drafts/` (10 file .md)
3. User review + edit
4. Submit vào OneMCP portal manual (paste vào form Create KB) hoặc script batch import qua CLI OneMCP
5. Maintainer publish tất cả

### Metrics baseline
- Đo `search_total`, `search_hit_verified`, `submit_total` weekly trong 4 tuần đầu qua OneMCP Prometheus

## Files to modify
- README.md, docs/deployment-guide.md, docs/mcp-setup-guide.md, docs/openwebui-user-guide.md
- mockups/onelog-services-detail.html, mockups/onelog-system-explainer.html

## Files to create
- docs/kb-workflow.md

## Todo
- [ ] Seed 5-10 published entries trước smoke (từ postmortem/journal team, hoặc user chỉ nguồn)
- [ ] 9 smoke test scenarios PASS (hoặc fail được ghi lại rõ)
- [ ] README service table + docs link
- [ ] deployment-guide env vars section
- [ ] mcp-setup-guide OneMCP section
- [ ] openwebui-user-guide flow section
- [ ] kb-workflow.md (new)
- [ ] mockups sync (2 files)
- [ ] Seed 5-10 entries (nếu có nguồn)
- [ ] Ghi baseline metric snapshot: 0 hits, 0 submits

## Success criteria
- 6 scenarios: ≥ 5 PASS (fallback scenario 4 nếu miss chỉ là note, không fail)
- Team member khác (không phải người build) có thể đọc docs làm được flow 1-3 mà không hỏi
- Baseline metrics captured để so sánh 4 tuần sau

## Risks
- **Scenario 4 miss** → prompt gap, cần iterate. Không blocking release.
- **Docs drift** khi Path A vs B khác — viết docs theo Path đã chọn Phase 2, note ngắn cho Path còn lại
- **Team không adopt** → cần training session ngắn (30 phút) — plan riêng, không nằm trong phase này

## Security
- Không expose ONEMCP_URL trong docs public nếu là internal DNS
- Screenshot docs redact token/user

## Staged rollout (V5 — 2026-07-23)
1. **Week 1** — enable Function + Action CHỈ cho admin/tri (`trihd@inet.vn`). Cách:
   - OpenWebUI Function/Action set per-user enable (Admin → Workspace → Functions → toggle "Enable for specific users")
   - Nếu OpenWebUI 0.10.2 không hỗ trợ per-user Function → deploy Function ở "disabled" default, tri manual enable trong personal settings
2. **Week 1 exit criteria**: ≥ 3 successful chat-to-KB flows (search hit + save flow) từ admin, không có crash/error trong OneMCP audit log
3. **Week 2** — enable cho full team, gửi announcement + link docs/kb-workflow.md
4. **Week 3+** — theo dõi metrics; decision escalate P4.2 pgvector sau 4 tuần (V6, giữ nguyên)

## Post-plan review (sau 4 tuần)
Data cần thu thập trước khi quyết escalate Option B (pgvector semantic):
- Số chat session gọi search
- Hit rate (verified hit / total search)
- Số submit qua chat, số published (approved)
- Miss cases: list 10 câu hỏi user hỏi mà search miss dù KB có entry liên quan (đọc audit log OneMCP + chat log OpenWebUI)
- LLM token savings ước lượng

Trigger decision:
- Hit rate ≥ 40% + adoption tốt → dừng, không cần semantic
- Hit rate < 40% + có evidence miss do synonym → mở plan mới `onemcp-pgvector-p4.2`
- Adoption thấp (< 5 sessions/tuần) → root cause khác (training? UX?), không phải search layer

## Next
- Nếu escalate → plan `onemcp-pgvector-p4.2` (contribute vào OneMCP)
- Nếu adoption thấp → training + UX iteration
