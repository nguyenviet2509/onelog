# Phase 05 · Docs + runbook

## Context
- Plan: [../plan.md](../plan.md)
- Prereq: Phase 01-04 xong. Dashboard live, alert firing đúng.

## Overview
- Priority: LOW · MUST · deliver operability
- Deliverable: 1 doc runbook · update deploy guide · update index mockup · sync `client-deploy-config` với biến `.env` mới.

## Key insights
- Ops phải tự làm được: add panel, tune threshold, rotate admin key, disable Gemini estimate, restore Grafana sau reboot.
- Doc phải copy-paste được, không hand-wave.
- Cross-link vào 5 mockup HTML sẵn có để dev mới hiểu big picture.

## Requirements

### Functional
- `docs/cost-dashboard.md` — runbook chính (~150 dòng, KISS)
- `docs/deployment-guide.md` — thêm section "Optional · Cost dashboard" pointer
- `mockups/onelog-index.html` — thêm card ⑦ hoặc cập nhật ⑥ cost dashboard đã live
- `mockups/onelog-client-deploy-config.html` — thêm biến mới (.env.cost, ADMIN_STRICT_CIDR, COST_DASHBOARD_TOKEN, GRAFANA_ADMIN_PASSWORD) vào bảng file cấu hình

### Non-functional
- Doc concise, sacrifice grammar
- Command block copy-paste được
- Có troubleshooting table cho 5-6 lỗi phổ biến

## Related files

### Create
- `docs/cost-dashboard.md`

### Modify
- `docs/deployment-guide.md`
- `mockups/onelog-index.html`
- `mockups/onelog-client-deploy-config.html`
- `docs/development-roadmap.md` (nếu tồn tại) · `docs/project-changelog.md`

## Implementation steps

1. **Write `docs/cost-dashboard.md`** — cấu trúc:
   - Golden rules (dashboard chỉ chạy khi profile `dashboard` up)
   - Kiến trúc 2 nguồn data (link mockup)
   - Quick deploy (5 lệnh)
   - Config `.env` block (biến mới)
   - Rotate admin API key (SOP 90d)
   - Add / edit panel Grafana (export JSON workflow)
   - Tune alert threshold
   - Disable Gemini estimate (nếu ops muốn ẩn)
   - Troubleshooting table
   - Rollback (disable profile dashboard, revert Caddyfile)

2. **Update `docs/deployment-guide.md`** — thêm 1 section ngắn:
   ```md
   ## Optional · Cost dashboard

   Dashboard xem cost/quota 4 LLM provider cho admin. Deploy sau khi stack chính OK.

   Xem [cost-dashboard.md](cost-dashboard.md) — bring-up 5 lệnh + rotate SOP.
   ```

3. **Update `mockups/onelog-index.html`**:
   - Nếu section cost dashboard đã có (mockup ⑥), cập nhật status "PROD-LIVE"
   - Nếu chưa có card riêng, thêm 1 card mới với link

4. **Update `mockups/onelog-client-deploy-config.html`**:
   - Bảng "Chi tiết từng file" → thêm rows: `infra/grafana/*`, `infra/litellm/.env.cost`, `infra/scripts/poll-provider-cost.sh`
   - Bảng "Kịch bản chỉnh sửa" → thêm rows: đổi threshold cost · rotate admin key · add Grafana panel
   - Bảng ENV → thêm biến `ADMIN_STRICT_CIDR`, `COST_DASHBOARD_TOKEN`, `GRAFANA_ADMIN_PASSWORD`, `.env.cost`

5. **Update changelog / roadmap** (nếu file exists):
   - `docs/project-changelog.md` — entry `2026-07-XX · feat(cost-dashboard): LLM cost + quota dashboard live`

6. **Verify docs**:
   - Copy 1 người ops mới, follow runbook từ đầu, deploy được không?
   - Missing bước gì → thêm vào doc

## Todo list

- [ ] Write `docs/cost-dashboard.md` full sections
- [ ] Include troubleshooting cho 5 case:
  - Panel empty sau restart Grafana
  - Provider_cost stream trống → cron chưa chạy
  - Alert không tới Telegram
  - Admin key expire (401 trong log)
  - Grafana bootstrap password quên
- [ ] Update `deployment-guide.md` add cost dashboard section
- [ ] Update `onelog-index.html` — status card cost dashboard "LIVE"
- [ ] Update `onelog-client-deploy-config.html` — 3 bảng có thông tin mới
- [ ] Add entry vào changelog (nếu file có)
- [ ] Dry-run: 1 ops khác đọc doc, deploy Phase 01+02 fresh — smooth không?
- [ ] Screenshot final dashboard, đính vào doc

## Success criteria
- Ops mới đọc `cost-dashboard.md` xong deploy được Phase A trong < 30 phút không cần hỏi
- 5 case troubleshooting cover 90% lỗi thực tế trong tuần đầu
- All cross-link giữa docs · mockups · plans hoạt động (không 404)
- `mockups/onelog-index.html` phản ánh trạng thái thật

## Risk assessment

| Risk | Mitigation |
|---|---|
| Doc lỗi thời sau khi threshold thay đổi | Note "verify against `.env.example`" cuối doc · single source of truth = `.env.example` |
| Ops skip rotate admin key SOP | Alert vmalert nhắc 80 ngày sau tạo key (nếu track được) · calendar reminder trong team |
| Runbook quá dài không đọc | Cap 200 dòng · TL;DR đầu file · sacrifice grammar |

## Security considerations
- Doc KHÔNG chứa key thật (chỉ format `sk-admin-...`)
- Screenshot dashboard blur out balance số nếu share ra team channel

## Next steps
- Nếu Phase B (03+04) chưa deploy → doc note rõ "chỉ Phase A live"
- Sau 2 tuần soak, chạy `/ck:plan validate` review threshold có phù hợp không
- Optional Phase 06 tương lai: auto-kill virtual key khi vượt cap (không phải plan này)
