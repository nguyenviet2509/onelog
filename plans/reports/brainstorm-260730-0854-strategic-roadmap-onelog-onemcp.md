---
type: brainstorm
date: 2026-07-30
slug: strategic-roadmap-onelog-onemcp
context: strategic feature roadmap, solo dev, both systems
status: agreed
---

# Brainstorm — Roadmap chiến lược OneLog + OneMCP

## Context

- **Actual users:** Ops (OneMCP runbook daily) + Support (FAQ KB)
- **Biggest pain:** Auth — manual API key/identity management
- **Dev bandwidth:** 1 người
- **Driver:** Strategic, big-picture prioritization

## Key insight

Solo dev → không thể parallel 2 hệ thống thực sự. Phải sequential. Câu hỏi đúng là thứ tự ROI tối ưu.

OneMCP > OneLog về urgency vì Ops/Support đang dùng hàng ngày. Auth pain = barrier adoption mọi feature khác.

## Roadmap

### 🔴 Tier 1 — Fix daily pain (~2 tuần)

| # | Feature | System | Effort | Why |
|---|---|---|---|---|
| 1 | **GitLab SSO** | OneMCP | 5-7 ngày | Pain #1 xác nhận. Unblocks auth cleanup, bridge migration, portal layout. External blocker: OAuth app registration — resolve ngay. Plan: [260727-0843](../260727-0843-onemcp-gitlab-sso/) |
| 2 | **Portal prod rebuild** | OneMCP | ~1 ngày | Phase 3 code done (b236bc5), chưa deploy. Free lunch. |

### 🟠 Tier 2 — Expand giá trị user đang có (2-6 tuần post SSO)

| # | Feature | System | Effort | Why |
|---|---|---|---|---|
| 3 | **Dev/Product pilot** | OneMCP | 8 ngày | Plan [260730-0843](../260730-0843-onemcp-devproduct-pilot/). Champion confirmed. Dep: SSO xong trước. |
| 4 | **Search: related artifacts** | OneMCP | 3-4 ngày | Ops/Support daily search — leverage point cao. Hybrid search đã có, extend "bạn có thể xem thêm" + saved search. |
| 5 | **KB Phase 2: cleanup cron + verify UI** | OneLog | 3-4 ngày | Target Aug 1. Unblock Phase 3+. |

### 🟡 Tier 3 — Capability mới (6-12 tuần)

| # | Feature | System | Effort | Why |
|---|---|---|---|---|
| 6 | **Blind arena finalize** | OneLog | 2-3 ngày | In-progress, gần xong. Finish để không stale. |
| 7 | **KB Phase 3: manual entry** | OneLog | 3-5 ngày | Target Aug 15. Content không từ chat. |
| 8 | **Submit flow: auto-extract quality** | OneMCP | 5-7 ngày | Bridge tóm tắt + template matching cải thiện. "📚 button" → OneMCP flow smoother. |

### ⚪ Tier 4 — Defer (>3 tháng, validate trước)

- OneLog KB Phase 4-7 (taxonomy, analytics, batch import, PDF export)
- OneMCP HR/Sales dept expansion (chờ Dev/Product pilot 4 tuần)
- Clone-from space tooling (chờ dept #2)
- Sensitive flag / fine-grained permission
- Analytics/cost dashboard management
- OIDC/SSO self-service

## Không làm

| Feature | Lý do |
|---|---|
| Real-time collab, comments | YAGNI — Ops/Support async OK |
| WYSIWYG block editor | Non-goal đã chốt |
| Mobile app | Desktop-first đủ nội bộ |
| Notification system | Chưa có demand xác nhận |
| OneLog↔OneMCP 2-way sync | Complexity cao, giá trị chưa rõ |

## Sequencing (solo dev)

```
Tuần 1-2:  GitLab SSO (OAuth app → register ngay hôm nay)
Tuần 3:    Portal prod rebuild + KB Phase 2 cleanup
Tuần 4-5:  Dev/Product pilot Phase 1-2
Tuần 6:    Search related artifacts
Tuần 7:    Blind arena finalize + KB Phase 3
Tuần 8-9:  Dev/Product pilot Phase 3-4
Tuần 10+:  Pilot retro → quyết HR/Sales, clone-from GO/NOGO
```

## Action ngay bây giờ

1. **Register GitLab OAuth app** với iNET GitLab admin → callback `https://202.92.5.113/api/auth/gitlab/callback` (TLS SAN regen cần theo dõi)
2. Unblock plan [260727-0843-onemcp-gitlab-sso](../260727-0843-onemcp-gitlab-sso/) để cook

## Unresolved

- SAN regeneration cho GitLab callback URL: public IP hay domain? Cần confirm trước Phase 1 SSO
- Submit flow quality: có cần measure current tóm tắt quality trước khi improve, hay cứ ship improvement?
- OneLog KB Phase 2 target Aug 1: thực tế còn bao nhiêu ngày? Nếu slip sau SSO → acceptable?
