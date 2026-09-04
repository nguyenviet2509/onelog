# Central RBAC UI — design guidelines

Quy ước responsive + primitive cho `central-rbac-ui`. Đọc trước khi thêm page/dialog/table mới.

## Nguyên tắc

- **Mobile-first bằng primitive**, không patch page-by-page. Layout + overlay + table đã responsive sẵn ở primitive → feature mới dùng primitive = free mobile.
- Grep `@responsive` để tìm primitive chịu responsive contract. Sửa mấy file này phải giữ contract.
- Breakpoint Tailwind mặc định: `sm 640 / md 768 / lg 1024 / xl 1280`. Test tối thiểu 375px (iPhone SE) + 768px (iPad).

## Primitives responsive-by-default

| File | Contract |
|---|---|
| `components/layout/app-shell.tsx` | Sidebar off-canvas `< lg`, hamburger trong Header toggle. Main padding `p-4 md:p-6`. |
| `components/layout/sidebar.tsx` | Fixed drawer `< lg`, static column `≥ lg`. Backdrop + ESC + NavLink click auto-close. |
| `components/layout/header.tsx` | Hamburger `lg:hidden`. Avatar-only `< sm`, displayName + chevron ẩn. |
| `components/ui/dialog.tsx` | `w-[calc(100vw-1rem)] max-w-lg`, `p-4 sm:p-6`, `max-h-[calc(100vh-2rem)] overflow-y-auto`. |
| `components/ui/drawer.tsx` | `w-full` `< sm`, `max-w-2xl` `≥ sm`. Header/body padding tighten. |
| `components/data-table.tsx` | Optional `mobileCard` prop → card list `< md`. Fallback `overflow-x-auto`. |

## Checklist khi thêm feature mới

### Page mới
- Dùng `AppShell` layout (route đặt trong `App.tsx` dưới AppShell) → free sidebar + header responsive.
- Container: **KHÔNG** dùng `max-w-*xl mx-auto` cứng nếu cần full-width mobile. Nếu dùng, gắn `space-y-4` cho vertical rhythm.
- Header page: `flex items-start justify-between gap-3 flex-wrap`.

### Table
- 4+ cột → **BẮT BUỘC** dùng `DataTable` với `mobileCard` prop.
- Cột phụ (chỉ hữu ích ≥ lg): `hidden lg:table-cell` trên `<th>` + `<td>`.
- Raw `<table>` fallback (khi không hợp DataTable): wrap `hidden md:block` + viết card list `md:hidden` song song. Xem `apps-list-page.tsx` làm mẫu.

### Action button row
- **BẮT BUỘC** `flex flex-wrap gap-2`. Không có `flex-wrap` = mobile tràn ngang.
- 3+ button destructive/primary/outline: check thứ tự visual hierarchy trên mobile (button ăn full width khi wrap).

### Dialog
- Dùng `DialogContent` (không viết Radix trực tiếp). Padding/width/max-height đã safe.
- Nội dung dialog: `space-y-3` hoặc `space-y-4`, tránh grid cứng > 2 cột trên mobile.

### Drawer
- Dùng `DrawerContent`. Nội dung dài → sẽ tự scroll.

### Input row
- Search: `className="w-full sm:max-w-sm"` (mobile full-width, desktop giới hạn).
- Multi-input form: mặc định stack dọc `space-y-3`, chỉ dùng `grid grid-cols-2` khi cả 2 field ngắn (< 20 char) hoặc `sm:grid-cols-2`.

### Text
- Title page: `text-xl sm:text-2xl` (không dùng `text-2xl` cứng).
- Truncate: dùng `truncate` + `min-w-0` trên parent flex — nếu không, `truncate` không có tác dụng.

### Touch targets
- Button primary/destructive: `size="sm"` OK (32px cao). Tránh custom < 32px.
- Icon-only button: `p-2` tối thiểu (~40px tap area).

## Anti-patterns

| Bad | Good |
|---|---|
| `<table>` raw không có mobile fallback | `DataTable` + `mobileCard` HOẶC `hidden md:block` + card list `md:hidden` |
| `max-w-6xl mx-auto` + không `flex-wrap` trên header row | Thêm `flex-wrap gap-3` cho header |
| `<Input className="max-w-sm">` mobile bị mất trắng bên phải | `w-full sm:max-w-sm` |
| `flex items-center gap-4` action row 3+ button | `flex items-center gap-2 flex-wrap` |
| Dialog width `w-96` cứng | `DialogContent` mặc định |
| Font `text-2xl` cho title, mobile quá to | `text-xl sm:text-2xl` |
| Sidebar/nav không có drawer mobile | Đặt route trong `AppShell` |

## Khi phá primitive contract

Nếu buộc phải phá `@responsive` contract (VD dialog full-screen cho wizard):
1. Xóa `@responsive` khỏi header primitive **hoặc** clone primitive thành variant riêng.
2. Update `docs/design-guidelines-central-rbac-ui.md` cùng PR.
3. Note lý do phá contract trong PR description.

Không sửa lén — primitive impact toàn app.
