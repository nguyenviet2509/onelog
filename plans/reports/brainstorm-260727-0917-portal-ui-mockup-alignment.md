# OneMCP Portal UI — Mockup alignment (Approach C)

**Date:** 2026-07-27
**Status:** Design approved — plan pending creation
**Blocked by:** SSO plan `260727-0843-onemcp-gitlab-sso` ship trước

## Vấn đề

Portal hiện tại (Phase 3 v1.5 ship) không match mockup mới:
- Layout top-nav (không sidebar)
- Không có greeting + stat cards
- Status badges mono style (không semantic color)
- Icon overuse (Clock trong recent activity, 📚 button, ⭐ saved searches, 🔥 top viewed)
- Saved searches sidebar chỉ placeholder stub
- Space selector nhỏ chip top-right thay vì prominent sidebar section

**User rules:**
- Đẹp hơn (match mockup structural)
- Dễ sử dụng
- Hạn chế icon (< mockup)

## Gap giữa mockup ↔ portal

| Aspect | Mockup | Current | Gap |
|---|---|---|---|
| Layout | Left sidebar 240px + main flex | Top nav horizontal | Structural change |
| Sidebar sections | Brand + SPACE + Nav (5 items) + SAVED SEARCHES + Secondary (Profile/API/Spaces/Onboarding) | Nav ngang, saved searches stub | New structure |
| Header dashboard | Greeting "Chào tri," + space breadcrumb + Import + Submit new CTA | `PageShell title="Dashboard"` | New components |
| Stat cards | 4 cards trên fold (TOTAL KB / PENDING / DRAFTS / SEARCH HIT) | Không có | New |
| Status pills | Semantic color (green/amber/red) + template pills inline | Basic Badge mono | Color system |
| Recent activity | Card list với status pill + template pill + author · time | Widget với Clock icon + name + type | Icon reduce, layout refactor |
| Top viewed / Top tags | Numbered list / tag cloud, no icons | Có icons trong header | Icon reduce |
| Icon count | ~12/page (nav + sections + stars + CTA sparkle) | ~8-10 lucide + emoji | Reduce further |

## Decisions (user approved)

- **Approach C** — Sidebar layout + icon-minimal
- **Icon budget:** 5 site-wide (chỉ sidebar nav)
- **Dark-first**, giữ light mode fallback
- **Timing:** sau SSO ship (blocked by SSO plan)

## Design spec

### Layout (AppShell mới)

```
┌────────────────┬──────────────────────────────────────────┐
│  OneMCP        │  Chào {username},                        │
│  v1.5 · trihd  │  Space: ops-runbook · 47 pub · 12 review │
│                │                    [Import] [Submit new] │
│  SPACE         │                                          │
│  [ops-runbook▾]│  ┌─────┬─────┬─────┬─────┐              │
│                │  │ 47  │  3  │  2  │ 68% │              │
│  Dashboard  🎯 │  └─────┴─────┴─────┴─────┘              │
│  Artifacts  🎯 │                                          │
│  Search     🎯 │  Recent activity        Top viewed 7d    │
│  Skills     🎯 │  [published][runbook]   1. Restart... 42 │
│  Review q  [3] │  Restart caddy edge     2. VMAlert... 28 │
│                │  ...                                     │
│  SAVED SEARCH  │                                          │
│  VMAlert firing│                         Top tags         │
│  SEPay hook    │                         [caddy][sepay].. │
│  Billing FAQ   │                                          │
│                │                                          │
│  Profile       │                                          │
│  API keys      │                                          │
│  Spaces  admin │                                          │
│  Onboarding    │                                          │
└────────────────┴──────────────────────────────────────────┘
```

Sidebar 240px fixed · Main flex · Dark-first

### Icon set (5 site-wide)

| Placement | Icon (lucide) |
|---|---|
| Dashboard nav | `LayoutDashboard` |
| Artifacts nav | `FileText` |
| Search nav | `Search` |
| Skills nav | `Sparkles` |
| Review queue nav (+ count badge) | `ClipboardCheck` |

**Không có icon:** section headers, status pills (color+text only), saved searches (text list), CTA buttons (Import/Submit new text-only), profile/API keys/spaces/onboarding secondary nav (text-only).

### Semantic pill palette (dark)

| Pill | Tailwind |
|---|---|
| `published` | `bg-emerald-500/15 text-emerald-400 border-emerald-500/30` |
| `pending` | `bg-amber-500/15 text-amber-400 border-amber-500/30` |
| `rejected` | `bg-rose-500/15 text-rose-400 border-rose-500/30` |
| Template (`runbook/sop/faq/kb/report/research/postmortem`) | `bg-slate-500/15 text-slate-300 border-slate-500/30` |
| Tag | Neutral, hover primary |

Consolidate qua shadcn `Badge` `variant` API (extend existing).

### Dark palette tune

- Root bg `slate-950`
- Sidebar bg `slate-900`
- Cards `bg-slate-900` + `border-slate-800`
- Accent CTA "Submit new" `bg-violet-600 hover:bg-violet-500`
- Muted labels `text-slate-500 text-xs uppercase tracking-wide font-medium`
- Stat numbers `text-4xl font-semibold`

Light mode fallback: dùng shadcn defaults + Phase 3A tokens (không tune deep, đủ đọc).

### Component new/refactor

**New:**
- `portal/components/app-shell.tsx` — sidebar + main slot layout
- `portal/components/dashboard-stat-cards.tsx` — 4-card grid
- `portal/components/dashboard-greeting.tsx` — greeting + space breadcrumb + CTA row
- `portal/lib/status-pill-variants.ts` — shared variant helper cho status/template/tag pills

**Modify:**
- `portal/app/layout.tsx` — wrap AppShell
- `portal/components/page-shell.tsx` — giữ cho inner pages (không đụng)
- `portal/components/dashboard-widgets.tsx` + `dashboard-widgets-extra.tsx` — bỏ Clock icon, dùng semantic pills
- `portal/components/nav.tsx` — merge vào AppShell sidebar
- `portal/components/space-switcher.tsx` — move từ top-right sang sidebar SPACE section
- `portal/components/saved-searches-list.tsx` — wire thực list, bỏ star icon
- `portal/app/page.tsx` — dashboard mới với stat cards + greeting
- `portal/app/artifacts/page.tsx` — refactor pill styling (semantic status)
- `portal/app/search/page.tsx` — same
- `portal/app/login/page.tsx` — dùng PageShell riêng (không AppShell)

### Icon purge (grep + remove)

- `Clock` trong recent activity → text-only "Recent activity"
- 📚 emoji trong Submit KB CTA → "Submit new" text
- ⭐ trong saved searches → text-only + delete on hover
- 🔥 trong top viewed → text-only "Top viewed 7d"
- 🏷️ trong top tags → text-only "Top tags"

Grep target files: `portal/components/**/*.tsx`, `portal/app/**/*.tsx`

## Phasing (~5 ngày dev + 0.5 buffer)

| # | Phase | Effort |
|---|---|---|
| 1 | AppShell layout + sidebar structural + migrate layout.tsx | 1 ngày |
| 2 | Dashboard rewrite (greeting + stat cards + widget layout constrained) | 1 ngày |
| 3 | Sidebar sections wire (SPACE selector + saved searches list + secondary nav) | 0.5 ngày |
| 4 | Semantic pill system + Badge variant extension + refactor list/detail/search | 1 ngày |
| 5 | Icon purge (grep + remove all outside sidebar nav) | 0.5 ngày |
| 6 | Dark palette audit + a11y contrast + light mode fallback verify + QA all pages | 1 ngày |

## Risks

| Risk | Mitigation |
|---|---|
| Migrate mọi page qua AppShell breaks flow | Incremental — giữ PageShell cho inner, wrap ngoài với AppShell qua root layout |
| Widget width assumption break | CSS Grid responsive test mỗi widget |
| Guardrail cũ ≤8 icons vs mới ≤5 icons — vi phạm ở existing files | 1 pass grep + delete + docs update |
| Semantic pill conflict với existing color usage | Consolidate qua shadcn Badge `variant` API |
| Xung đột SSO `/login` layout | Login page dùng PageShell riêng, không AppShell |
| Cookie/session redirect qua Next.js middleware của SSO đè AppShell render | Test staging Phase 2 SSO xong mới merge UI plan |

## Success metrics

- Screenshot dashboard prod match ≥85% visual với mockup (side-by-side)
- Grep `lucide-react` imports: ≤5 icons render/page (verified)
- Grep hex/rgb inline: 0 violation (Tailwind tokens only)
- Grep `text-destructive` / `text-emerald-400` inline color: consolidate qua Badge variant, 0 stray
- All 16 pages render clean cả dark + light mode
- A11y contrast pass (WCAG AA min) cho dark palette
- User feedback qualitative "dễ dùng hơn" (informal survey sau 1 tuần ship)

## Non-goals

- ❌ Full mockup 100% pixel fidelity (60-70% acceptable)
- ❌ Custom animations / micro-interactions
- ❌ Mobile responsive detail (desktop-first, mobile OK-ish)
- ❌ Design token deep overhaul (dùng iNET tokens Phase 3A đã có)
- ❌ Icon library thứ 2 (chỉ lucide)

## Open questions

1. Sidebar SPACE section — hiển thị chỉ current space + dropdown, hay show pinned spaces list? Recommend: chỉ current + dropdown (KISS).
2. Empty state cho saved searches sidebar — hidden hoàn toàn hay text muted "No saved yet"? Recommend: text muted.
3. Mobile responsive breakpoint — collapse sidebar thành drawer < 768px? Hay skip mobile v1? Recommend: skip mobile v1, add later khi có nhu cầu.
4. Bảng chào (greeting): dynamic theo thời gian trong ngày ("Chào buổi sáng, tri")? Hay static "Chào tri,"? Recommend: static (KISS).
5. Import CTA button ở dashboard — hiện chưa có endpoint import bulk. Có nên hide đến khi backend ready? Recommend: hide (không show broken CTA).

## Cross-reference

- SSO plan (blocker): `plans/260727-0843-onemcp-gitlab-sso/`
- v1.5 Phase 3 portal work (baseline): `plans/260724-0821-onemcp-multidept-v1-5/phase-03-portal-polish.md`
- v1.5 Phase 3A iNET tokens: commit `706d6d6`
- User management v2 (defer): `plans/reports/brainstorm-260727-0909-onemcp-user-management-v2-defer.md`
