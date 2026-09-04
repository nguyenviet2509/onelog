# Portal UI polish — spacing scale + border token unification

**Date:** 2026-07-27
**Scope:** OneMCP portal (`D:/Vietnt/Project/onemcp/portal/`)
**Commit:** `043815e` on origin/master
**Deployed:** onemcp-vps (portal container rebuilt + restarted)

## Key spacing decisions

### 1. Card token — single source of truth
File: `components/ui/card.tsx`

Đổi CSS var `--card-spacing` default:
- Trước: `--spacing(4)` = 16px (default) / `--spacing(3)` = 12px (size=sm)
- Sau: `--spacing(3)` = 12px (default) / `--spacing(2.5)` = 10px (size=sm)

Card component tự động apply padding + gap qua CSS var → tất cả Card/CardHeader/CardContent nhận scale mới mà không cần chỉnh từng widget.

### 2. Stat cards — bỏ override
File: `components/dashboard-stat-card.tsx`

- Bỏ `pt-5 pb-4 px-5` (20px override) + `bg-card border-border` (thừa, đã là default) → dùng Card default 12px
- Con số: `text-4xl mt-1` → `text-3xl mt-0.5 leading-tight` (giảm chiều cao card ~30%, khớp label size)
- Skeleton: `h-9 w-16 mt-2` → `h-8 w-14 mt-1.5`

### 3. Pending review number
File: `components/dashboard-widgets.tsx`
- `text-3xl font-bold` → `text-2xl font-semibold leading-tight` (đồng bộ scale stat card)

### 4. Page container padding
- `app/page.tsx`: `px-6 py-8 space-y-6` → `px-6 py-6 space-y-4`
- `components/page-shell.tsx`: `py-8 mb-6` → `py-6 mb-4` (áp dụng cho artifacts, spaces, profile, artifact detail/edit)
- `app/skills/page.tsx`: `py-10` → `py-6`
- `app/artifacts/review/page.tsx`: `py-10` → `py-6`

### 5. Sidebar tightening
- `sidebar-brand.tsx`: `py-5` → `py-4`
- `app-shell.tsx` SPACE section: `py-3 mb-1.5` → `py-2.5 mb-1`
- `app-shell.tsx` SAVED SEARCHES header: `pt-3` → `pt-2.5`
- `app-shell.tsx` secondary block: `pt-2` → `pt-1.5`
- `sidebar-nav.tsx`: `py-3` → `py-2`
- `sidebar-secondary-nav.tsx`: `pb-4` → `pb-3`
- `saved-searches-list.tsx`: `pb-3` → `pb-2`

Tổng effective: sidebar footprint giảm ~14px chiều dọc, gap giữa các section nhất quán 10-12px.

### 6. Border token audit
Grep `border-(slate|gray|zinc)-[0-9]` khắp `portal/` → 0 hit ngoài `components/ui/badge.tsx` (semantic pills, đúng thiết kế).

Fix legacy hardcoded error banner:
- `border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950 text-red-900 dark:text-red-100` → `border-destructive/40 bg-destructive/10 text-destructive` (works in cả light + dark tự động, không cần dark: variant)

Áp dụng ở: `app/skills/page.tsx`, `app/artifacts/review/page.tsx`

### 7. Bonus: primary color unification (skills page)
- `text-blue-600 hover:border-blue-500` → `text-primary hover:border-primary/40 transition-colors`
- Bỏ `shadow-sm` thừa (Card đã có ring-1 riêng ở dashboard)

## Files changed (12)

**UI base (1):**
- `components/ui/card.tsx` — card-spacing token 16px→12px

**Dashboard (4):**
- `app/page.tsx` — page container py-8→py-6, space-y-6→4
- `components/dashboard-stat-card.tsx` — remove padding override
- `components/dashboard-widgets.tsx` — pending review number size
- (no change needed cho widgets-extra / greeting — đã dùng Card default OK)

**Sidebar (6):**
- `components/app-shell.tsx`
- `components/sidebar-brand.tsx`
- `components/sidebar-nav.tsx`
- `components/sidebar-secondary-nav.tsx`
- `components/saved-searches-list.tsx`
- (space-switcher + identify-as-dropdown ko cần chỉnh — inner padding đã 2.5)

**Shared shell + list pages (3):**
- `components/page-shell.tsx` — py-8→py-6, mb-6→mb-4
- `app/skills/page.tsx` — border tokens + py
- `app/artifacts/review/page.tsx` — border tokens + py

## Verification

- Build: `pnpm build` compile + lint + typecheck + generate 16 static pages OK. Chỉ fail ở bước cuối "copy traced files" do Windows symlink EPERM (env issue, không phải code lỗi). Deploy trên Linux VPS chạy bình thường.
- Grep border tokens: sạch (chỉ badge.tsx còn dùng slate-500/xx — đúng scope).
- Dark/light mode: dùng semantic tokens (bg-card, border-border, border-destructive, text-primary) → tự động switch, không hardcoded color.
- Icon budget: unchanged, vẫn 5 icon ở sidebar-nav.
- Không đổi logic/behavior, pure visual.
- Deploy VPS: portal container rebuild + up thành công.

## Không đụng vào (out of scope)

- `structured-editor.tsx`, `attachment-uploader.tsx`, `identify-as-dropdown.tsx`, `search/page.tsx`, `artifacts/[id]/page.tsx`, `artifacts/[id]/edit/page.tsx`, `profile/page.tsx`, `skills/[name]/page.tsx` vẫn còn vài `text-blue-500`, `bg-green-100`, `border-red-300` local trong buttons/status pills. Task nói dashboard scope + list pages → những chỗ này để phase sau nếu user muốn full audit.

## Unresolved questions

1. Có muốn đổi luôn `data-[size=sm]:[--card-spacing:--spacing(2.5)]` = 10px không, hay giữ 12px cho cả 2 (đơn giản hơn, YAGNI)?
2. Search/artifacts-detail/profile pages có nên polish tiếp không? (ước tính +30 phút cho full audit)
3. `text-3xl` cho stat number có đủ visual weight không? Nếu user muốn số to hơn có thể quay lại `text-4xl` nhưng vẫn giữ card padding 12px.

**Status:** DONE
**Summary:** 12 files edited, unified card-spacing token 16→12px, border tokens semantic-only, sidebar footprint tighter, dashboard page container py-8→6. Commit 043815e pushed + deployed to onemcp-vps.
