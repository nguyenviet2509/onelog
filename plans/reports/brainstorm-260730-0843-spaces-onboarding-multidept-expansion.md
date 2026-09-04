---
type: brainstorm
date: 2026-07-30
slug: spaces-onboarding-multidept-expansion
related_mockups:
  - mockups/onemcp-portal-v1-5-mockup.html
related_plans:
  - plans/260724-0821-onemcp-multidept-v1-5
pilot_dept: dev-product
status: agreed
---

# Brainstorm — Spaces & Onboarding: mở rộng multi-dept

## Vấn đề

Portal OneMCP v1.5 có 2 trang backbone cho chiến lược multi-dept:
- **Spaces admin** — namespace KB per team/dept ([mockup L798-866](../../mockups/onemcp-portal-v1-5-mockup.html))
- **Onboarding** — landing page onboard user mới của 1 dept (hardcode Ops, [mockup L868-927](../../mockups/onemcp-portal-v1-5-mockup.html))

Hiện chỉ phục vụ Ops + Support + Tech (v1.5). Cần định hình cách scale ra HR, Sales/CS, Dev/Product mà không rebuild.

## Trạng thái hiện tại

### Spaces
- Flat model, 4 space seed: `ops-runbook`, `ops-oncall`, `support-faq`, `tech-kb`
- Card list: icon, slug, desc, count artifacts/members, nút "New space"
- Filter search theo space, permission = membership, OpenWebUI Group map 1-1
- Chưa có: edit/archive/transfer, per-space settings, space templates

### Onboarding
- Hardcode Ops: welcome copy → video 5' → 3 quick actions → 3 use case → support contact
- Mục tiêu: user submit KB đầu tiên trong ~15 phút
- Chưa có: config per-dept, checklist tracking, i18n

## Approach evaluated

| # | Space model | Onboarding | Effort | Verdict |
|---|---|---|---|---|
| A | Flat + tag | YAML file config | Thấp | ✅ **Chọn** — KISS, đủ ≤10 dept |
| B | Hierarchical (dept→team→project) | DB config + admin UI | Cao | ❌ Over-engineer, perm inheritance phức tạp |
| C | Flat + tag | Guided tour lib (overlay tooltip) | Trung | ⚠️ Hoãn — UX modern nhưng khó maintain khi UI đổi |
| D | Flat + space templates (clone-from) | Interactive checklist + progress | Trung | ⚠️ Phần "clone-from" giữ lại, checklist hoãn |

## Recommended solution

### Spaces roadmap

**Convention:** `<dept>-<purpose>`. Mỗi dept 1-3 space, không nest.

| Dept | Space | Template mặc định |
|---|---|---|
| HR | `hr-policy`, `hr-onboarding` | `policy`, `onboarding-checklist` |
| Sales/CS | `sales-playbook`, `sales-scripts` | `objection-handling`, `discovery`, `case-study` |
| Dev/Product | `product-adr`, `product-spec`, `product-retro` | `adr`, `spec`, `retro` |

**Bổ sung tối thiểu (backlog):**
- Admin CRUD: edit name/icon/desc, archive, transfer owner
- Per-space settings: default template, reviewer group, retention
- **Clone-from space** khi tạo mới (copy templates + reviewer + onboarding config) → roll-out mỗi dept từ 1 ngày xuống 2h
- Tag whitelist per space (chống sprawl)

**Không làm:** nested space, per-artifact permission (giữ non-goal v1.5).

### Onboarding roadmap — config-driven

Schema YAML file-based (Phase 1), DB + admin UI (Phase 2, chờ demand ≥5 dept):

```yaml
# configs/onboarding/<space-slug>.yaml
space: hr-policy
audience: "HR team"
welcome:
  emoji: "👋"
  title: "Chào HR team!"
  subtitle: "..."
video: { url: "...", duration: "5m" }
quick_actions:
  - { icon: "📋", title: "Policy mẫu", desc: "...", href: "..." }
use_cases:
  - { title: "Onboard nhân viên mới", template: "onboarding-checklist" }
support: { channel: "#onemcp-hr", mentions: ["@hr-lead"] }
```

**Route:** `/onboarding/<space-slug>` render dynamic. Fallback tới generic template nếu chưa config.

### Roll-out playbook per dept (~1-2 tuần)

1. Champion + dept lead identify (blocker chính)
2. Seed 3-5 artifact + template mới nếu cần (dept lead)
3. Admin tạo space + clone-from `ops-runbook` (2h)
4. Fill onboarding YAML (dept lead + dev pair, 3h)
5. OpenWebUI Group scoping (map 1-1 space)
6. Soft launch → measure 4 tuần: submit rate, hit rate, MAU

### Dept-specific gotcha

- **HR** — payroll/review nhạy cảm. Cần flag `sensitive` per artifact (không lộ trong global search). Phase 2 nếu HR onboard sớm.
- **Sales/CS** — tag theo `product/segment/campaign`. Test tag whitelist ở đây trước.
- **Dev/Product** — overlap Notion/GitHub. Định vị OneMCP = artifact "durable" (ADR chốt, retro ký, spec ship). Working doc → Notion. Convention-driven, không code enforce.

## Pilot chọn: Dev/Product

Champion đã confirm miệng. Rationale:
- Team dev sát repo, ít friction adoption
- Test được ranh giới OneMCP vs Notion/GitHub → thu bài học cho dept khác
- ADR/retro là artifact "durable" đúng use case OneMCP
- Feedback loop nhanh (champion là dev)

## Success metrics (đo 4 tuần post-pilot)

- ≥ 5 ADR + ≥ 3 retro published vào `product-adr` / `product-retro`
- ≥ 3 dev submit KB (không chỉ champion)
- Search hit rate ≥ 60%
- 0 confusion ticket "Notion hay OneMCP?" (proxy cho định vị rõ)
- YAML config editable trong <30' bởi champion (không cần dev)

## Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Champion pull out | High | Phase 0 = confirm bằng chữ, seed sẵn 3 artifact demo |
| Overlap Notion → dev không dùng | High | Docs định vị rõ + đo confusion ticket. Sau 4 tuần nếu MAU <30% dev → xem lại pitch |
| Config YAML hard cho non-dev | Med | Dev pair champion khi fill lần đầu. Nếu cần thường xuyên → tăng ưu tiên Phase 2 (admin UI) |
| Tag sprawl | Low | Whitelist tag per space (backlog Spaces) |
| Clone-from tooling tốn hơn dự kiến | Low | Nếu >5 ngày → skip, seed thủ công cho pilot |

## Trade-offs

| Chọn | Được | Mất |
|---|---|---|
| Flat + tag | KISS, ≤10 dept ok | Tag sprawl nếu no whitelist |
| YAML file-based | Dev nhanh, git-versioned | Champion cần dev support edit |
| Clone-from | Roll-out mỗi dept nhanh | Cần build tooling ~3-5 ngày |
| Pilot Dev/Product | Champion sẵn, feedback nhanh | Risk overlap Notion cao nhất |

## Next steps

1. Tạo `/ck:plan` cho pilot Dev/Product (phase-01 space setup, phase-02 onboarding config, phase-03 clone-from tooling optional, phase-04 seed + soft launch, phase-05 measure)
2. Sau pilot 4 tuần → audit v1.5 metric tổng thể → quyết HR / Sales next
3. Space CRUD polish + tag whitelist đưa vào backlog OneMCP core (không block pilot)

## Unresolved

- Có sensitive flag cho HR không (chưa cần cho Dev/Product pilot, để mở)
- Admin UI edit onboarding config: khi nào trigger? (đề xuất: khi có ≥5 dept dùng OR champion feedback edit >2 lần/tháng)
- Clone-from space tooling: build ngay trong pilot hay hoãn tới dept thứ 2? (Đề xuất: hoãn — pilot dùng seed thủ công, đo effort thật trước khi tự động hoá)
