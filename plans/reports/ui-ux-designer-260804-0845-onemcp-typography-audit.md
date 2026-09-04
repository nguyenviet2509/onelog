# OneMCP Portal — Typography Consistency Audit

**Date:** 2026-08-04
**Scope:** `D:\Vietnt\Project\onemcp\portal\` (app/ + components/, excluding node_modules/backend)
**Mode:** Read-only research

---

## A. Existing design tokens

### `tailwind.config.ts`
- **Font family:** `sans = var(--font-inter), system-ui, ...` (Inter self-hosted via next/font)
- **Font size scale** (custom-declared, matches Tailwind defaults):
  - `xs   = 0.75rem  / 1rem`
  - `sm   = 0.875rem / 1.25rem`
  - `base = 1rem     / 1.5rem`
  - `lg   = 1.125rem / 1.75rem`
  - `xl   = 1.25rem  / 1.75rem`
  - `2xl  = 1.5rem   / 2rem`
  - `3xl  = 1.875rem / 2.25rem`
  - `4xl  = 2.25rem  / 2.5rem`
- **NO custom font-weight utilities defined** — uses Tailwind defaults (`font-medium=500`, `font-semibold=600`, `font-bold=700`).

### `globals.css`
- Body: `font-family: var(--font-inter)`, `letter-spacing: -0.005em` (global tight tracking).
- Color tokens (Option A / Linear-style): `--foreground`, `--muted-foreground`, `--destructive`, `--primary`, `--card-foreground`.

### Canonical component defaults (design intent)
| Component | Class string | File |
|---|---|---|
| **Page H1** (`PageShell`) | `text-xl font-semibold tracking-tight text-foreground` | `components/page-shell.tsx:41` |
| **Breadcrumb** | `text-xs text-muted-foreground` | `components/page-shell.tsx:23` |
| **CardTitle** | `text-sm font-semibold text-foreground` | `components/ui/card.tsx:36` |
| **CardDescription** | `text-xs text-muted-foreground` | `components/ui/card.tsx:46` |
| **Card body** (inherits) | `text-sm` (on `<Card>`) | `components/ui/card.tsx:11` |
| **Button** | `text-[13px] font-medium` (arbitrary!) | `components/ui/button.tsx:10` |
| **Badge** | `text-[11px] font-medium` (arbitrary!) | `components/ui/badge.tsx:10` |
| **Input** | `text-[13px]` (arbitrary!) | `components/ui/input.tsx:13` |
| **Label** | `text-sm leading-none font-medium` | `components/ui/label.tsx:12` |
| **EmptyState title (default)** | `text-sm font-medium text-foreground` | `components/empty-state.tsx:35` |
| **EmptyState desc** | `text-xs text-muted-foreground` | `components/empty-state.tsx:39` |
| **EmptyState title (compact)** | `text-xs font-medium text-muted-foreground` | `components/empty-state.tsx:35` |
| **Section eyebrow label** | `text-[10px] font-semibold uppercase tracking-wider text-muted-foreground` | `components/app-shell.tsx:71` (7 usages) |
| **Sidebar nav item** | `text-[13px]` (arbitrary) | `components/sidebar-nav.tsx:48` |
| **Stat card number** | `text-[26px] font-semibold leading-none tracking-tight` (arbitrary!) | `components/dashboard-stat-card.tsx:32` |
| **Stat card label** | `text-[10px] font-semibold uppercase tracking-wider` | `components/dashboard-stat-card.tsx:26` |

**Observation:** The design system deliberately uses **arbitrary px sizes for form/button/input** (13px) and **badges** (11px, 10px) as an Option-A/Linear signature. These are intentional. The rest of the codebase should NOT invent more arbitrary sizes.

---

## B. Role inventory

### H1 / Page title
| Class | Count | Examples |
|---|---|---|
| `text-xl font-semibold tracking-tight text-foreground` | **6 (dominant)** | `page-shell.tsx:41`, `skills/page.tsx:51`, `skills/[name]/page.tsx:73`, `profile/page.tsx:36`, `dashboard-greeting.tsx:24`, `artifacts/[id]/edit/page.tsx:89` |
| `text-2xl font-semibold tracking-tight` | 2 | `search/page.tsx:202`, `artifacts/[id]/page.tsx:84` |
| `text-2xl font-bold` | 1 | `artifacts/review/page.tsx:37` |

### H2 / Section title
| Class | Count | Examples |
|---|---|---|
| `text-sm font-semibold` | **3 (dominant)** | `artifacts/[id]/page.tsx:173`, `attachment-uploader.tsx:71`, `artifact-review-actions.tsx:39` |
| `text-sm font-semibold text-foreground` | 1 | `onboarding/page.tsx:40` |
| `text-sm font-semibold uppercase tracking-wider text-muted-foreground` | 1 | `skills/[name]/page.tsx:116` |
| Markdown `[&_h2]:text-lg font-semibold` | 1 | `markdown-view.tsx:57` (prose context, ignore) |

### H3 / Sub-section — via `CardTitle`
Canonical `text-sm font-semibold text-foreground` (single source in `card.tsx`). One override in `template-picker.tsx:74` (`text-sm` explicit override = same result).

### Body / paragraph
| Class | Count | Notes |
|---|---|---|
| `text-sm text-muted-foreground` | **~18 (dominant)** | secondary body copy |
| `text-sm` (inherited from Card / raw) | many | primary body |
| `text-base` on paragraphs | 0 | never used for prose body |

### Meta / caption / helper text
| Class | Count | Examples |
|---|---|---|
| `text-xs text-muted-foreground` | **~30 (dominant)** | `dashboard-widgets.tsx:94,154`, `artifacts/page.tsx:84`, `skills/page.tsx:104,123`, `spaces/[id]/page.tsx:113`, `artifacts/[id]/page.tsx:73,85,187`, `template-picker.tsx:76`, `attachment-uploader.tsx:92,104,119` |
| `text-[11px] text-muted-foreground` | 3 | `sidebar-user-card.tsx:94,119`, `sidebar-brand.tsx:22` |
| `text-[10px] text-muted-foreground` | 5 | `space-switcher.tsx:65,68`, `identify-as-dropdown.tsx:104,123,130`, `saved-searches-list.tsx:90` |
| `text-[12px] text-muted-foreground` | 2 | `sidebar-user-card.tsx:118`, `app-shell.tsx:32` |

### Section eyebrow label (small uppercase caps)
| Class | Count | Examples |
|---|---|---|
| `text-[10px] font-semibold uppercase tracking-wider text-muted-foreground` | **7 (dominant)** | `app-shell.tsx:71`, `dashboard-stat-card.tsx:26`, `sidebar-secondary-nav.tsx:25`, `sidebar-user-card.tsx:131,156`, `identify-as-dropdown.tsx:75,113` |
| `text-xs font-semibold uppercase tracking-wider text-muted-foreground` | 2 | `artifact-detail-sidebar.tsx:44`, `skills/[name]/page.tsx:116` |
| `text-xs font-medium uppercase tracking-wide text-muted-foreground` | 2 | `artifacts/new/page.tsx:320`, `artifacts/[id]/edit/page.tsx:113` |

### Table `<th>`
| Class | Count | Examples |
|---|---|---|
| `px-4 py-3 text-left font-medium text-muted-foreground` (no explicit size → inherits `text-sm` from parent `<table className="w-full text-sm">`) | **10 (dominant)** | `spaces/page.tsx:148-151`, `profile/api-keys/page.tsx:104-109` |
| `px-4 py-2.5 text-left text-xs font-medium text-muted-foreground` | 5 | `skills/[name]/page.tsx:126-130` |

### Table `<td>`
| Class | Count | Notes |
|---|---|---|
| Inherits `text-sm` from `<table>` (default) | many | canonical |
| `font-mono text-xs text-muted-foreground` (id/slug column) | 4 | `spaces/page.tsx:158`, `profile/api-keys/page.tsx:118`, `skills/[name]/page.tsx:140`, `142` |

### Button label
Single source: `Button` component → `text-[13px] font-medium`. Sizes `xs`/`sm` override to `text-xs`. `text-[13px]` is intentional (Option A).

### Badge / pill
Single source: `Badge` component → `text-[11px] font-medium`. **But** at least 6 hand-rolled badge-shaped spans use `text-[11px]` inline instead of `<Badge>`:
- `skills/page.tsx:68,80,130,140`
- `skills/[name]/page.tsx:99,151,158,198`
- `artifacts/page.tsx:89,96` (Edit/Delete row actions)

### Form label
| Class | Count | Notes |
|---|---|---|
| `<Label>` component → `text-sm font-medium` | canonical | `components/ui/label.tsx:12` |
| Inline `<span className="text-sm font-medium">` | 4 | `artifacts/new/page.tsx:281,293,308,327` — should use `<Label>` |
| `<label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">` | 1 | `artifacts/[id]/edit/page.tsx:113` — different eyebrow style |

### Empty state title / description
Fully centralized via `<EmptyState>` component. No drift found.

---

## C. Drift table (roles with divergent usages)

| Role | Canonical (proposed) | Divergent usages (file:line) |
|---|---|---|
| **Page H1** | `text-xl font-semibold tracking-tight text-foreground` (6 vs 3) | `search/page.tsx:202` (`text-2xl`); `artifacts/[id]/page.tsx:84` (`text-2xl`); `artifacts/review/page.tsx:37` (`text-2xl font-bold`) |
| **Section H2** | `text-sm font-semibold` (matches CardTitle for visual rhythm) | `skills/[name]/page.tsx:116` (`text-sm ... uppercase tracking-wider text-muted-foreground` — this is an eyebrow, not a section header — rename semantically) |
| **Section eyebrow label** | `text-[10px] font-semibold uppercase tracking-wider text-muted-foreground` (7 vs 4) | `artifact-detail-sidebar.tsx:44` (`text-xs font-semibold ...`); `skills/[name]/page.tsx:116` (`text-sm font-semibold ...`); `artifacts/new/page.tsx:320` (`text-xs font-medium ... tracking-wide`); `artifacts/[id]/edit/page.tsx:113` (`text-xs font-medium ... tracking-wider`) |
| **Meta caption** | `text-xs text-muted-foreground` (~30 vs 10 arbitrary) | `sidebar-user-card.tsx:94,119`; `sidebar-brand.tsx:22`; `space-switcher.tsx:65,68`; `identify-as-dropdown.tsx:104,123,130`; `saved-searches-list.tsx:90`; `app-shell.tsx:32` (`text-[12px]`) |
| **Table `<th>` size** | inherit `text-sm` from `<table className="w-full text-sm">` (10 vs 5) | `skills/[name]/page.tsx:126-130` uses `text-xs` explicit override (inconsistent with `spaces/page.tsx` and `profile/api-keys/page.tsx`) |
| **Row action mini-button** | `<Button size="xs">` (uses `text-xs`) | `artifacts/page.tsx:89,96` (`text-[11px] font-medium`); `skills/[name]/page.tsx:151,158` (`text-[11px] font-medium`) — should use Button component |
| **Inline badge/chip** | `<Badge>` (uses `text-[11px]`) | `skills/page.tsx:68,80,130,140`; `skills/[name]/page.tsx:99,198`; `dashboard-widgets-extra.tsx:115`; `profile/page.tsx:79`; `artifact-detail-sidebar.tsx` (implicit via labelCls) |
| **Form field label** | `<Label>` (uses `text-sm font-medium`) | `artifacts/new/page.tsx:281,293,308,327` (`<span className="text-sm font-medium">`) |
| **Review CTA button** | `<Button variant="default">` (text-[13px]) | `artifacts/review/page.tsx:78` (`text-sm font-medium bg-primary` — hand-rolled) |
| **Review artifact link title** | `text-sm font-medium` (row-title canonical, see `artifacts/page.tsx:68`) | `artifacts/review/page.tsx:67` (`text-base font-semibold`) |

---

## D. Arbitrary sizes to eliminate

Arbitrary `text-[Npx]` usages that DUPLICATE an existing token OR violate the canonical scale.

### Keep (intentional Option-A tokens — do NOT touch)
- `text-[13px]` in `ui/button.tsx:10`, `ui/input.tsx:13`, `sidebar-nav.tsx:48`, `sidebar-secondary-nav.tsx:36`, `pagination.tsx:25,62` — signature "13px form/nav" is documented design intent.
- `text-[11px]` in `ui/badge.tsx:10` — signature badge size.
- `text-[10px] uppercase tracking-wider` (eyebrow label pattern) — used 7× consistently, treat as canonical eyebrow.
- `text-[26px]` in `dashboard-stat-card.tsx:32` + `dashboard-widgets.tsx:192` — stat card display number.

### Eliminate (drift / duplication)

| Location | Current | Suggested replacement |
|---|---|---|
| `dashboard-widgets-extra.tsx:115` | `text-[11px] font-medium` (hand-rolled tag chip) | `<Badge variant="tag">` |
| `skills/page.tsx:68,80` (filter chips) | `text-[11px] font-medium` | `<Badge variant="tag">` or `<Button size="xs" variant="ghost">` |
| `skills/page.tsx:130` (mono chip) | `font-mono text-[11px] font-medium` | `<Badge variant="template">` |
| `skills/page.tsx:140` (status chip) | `text-[11px] font-medium` | `<Badge variant="status-...">` |
| `skills/[name]/page.tsx:99,198` (mono chip / status chip) | `text-[11px]` | `<Badge variant="template">` / `<Badge variant="status-...">` |
| `skills/[name]/page.tsx:151,158` (row action buttons) | `text-[11px] font-medium` | `<Button size="xs">` (variants `default` / `destructive`) |
| `artifacts/page.tsx:89,96` (Edit/Delete row actions) | `text-[11px] font-medium` | `<Button size="xs" variant="ghost">` |
| `profile/page.tsx:79` (dept chip) | `font-mono text-[11px] font-medium` | `<Badge variant="template">` |
| `sidebar-user-card.tsx:88` (Save btn) | `text-[11px]` | `<Button size="xs">` |
| `sidebar-user-card.tsx:94,113,118,119` | `text-[11px]` / `text-[12px]` | `text-xs` for meta; keep avatar initials `text-[11px]` as sidebar-signature if intentional |
| `space-switcher.tsx:65,68` | `text-[10px]` | `text-xs` (avoids introducing 10px meta variant) |
| `identify-as-dropdown.tsx:104,123,130` | `text-[10px]` | `text-xs` |
| `sidebar-user-card.tsx:99` | `text-[10px] leading-tight text-destructive` | `text-xs text-destructive` |
| `saved-searches-list.tsx:81,90` | `text-[10px]` | `text-xs` (Badge already provides its own size) |
| `markdown-view.tsx:42` (copy btn overlay) | `text-[10px] font-medium` | `text-xs font-medium` |
| `app-shell.tsx:32` (search trigger) | `text-[12px]` | `text-xs` OR promote to sidebar-signature `text-[13px]` to align with nav |
| `app-shell.tsx:35` (kbd hint) | `text-[10px]` | `text-xs` |
| `sidebar-brand.tsx:12` (logo mark 6-square) | `text-[11px] font-bold` | keep (glyph-level, not text flow) |
| `sidebar-nav.tsx:65` (nav count badge) | `text-[10px]` | let `<Badge>` control it — remove override |
| `artifact-review-actions.tsx:50` textarea | `text-[13px]` (already OK, matches Input) | keep |
| `artifacts/[id]/edit/page.tsx:119,134` (raw input/button) | `text-[13px]` | replace with `<Input>` / `<Button>` components |
| `artifacts/[id]/edit/page.tsx:113` | `text-xs font-medium uppercase tracking-wider` | `text-[10px] font-semibold uppercase tracking-wider` (eyebrow canonical) |
| `artifacts/new/page.tsx:320` | `text-xs font-medium uppercase tracking-wide` | `text-[10px] font-semibold uppercase tracking-wider` |

No `style={{ fontSize: ... }}` inline usages found.

---

## E. Recommended canonical scale

| Role | Utility class |
|---|---|
| **H1 — Page title** | `text-xl font-semibold tracking-tight text-foreground` (via `<PageShell title>`) |
| **H1 — Hero page (search/detail)** | Optional escalation `text-2xl font-semibold tracking-tight` — **but pick one**; recommend collapse to `text-xl` for consistency, use `text-2xl` only if design-lead approves hero variant |
| **H2 — Section title** | `text-sm font-semibold text-foreground` |
| **H3 / CardTitle** | `text-sm font-semibold text-foreground` (already canonical via `<CardTitle>`) |
| **Eyebrow label** (small caps) | `text-[10px] font-semibold uppercase tracking-wider text-muted-foreground` |
| **Body — primary** | `text-sm text-foreground` (Card inherits; `<p>` explicit) |
| **Body — secondary** | `text-sm text-muted-foreground` |
| **Meta / caption / helper** | `text-xs text-muted-foreground` |
| **Table `<th>`** | `text-left font-medium text-muted-foreground` (inherits `text-sm` from `<table className="w-full text-sm">`) |
| **Table `<td>`** | inherits `text-sm` — no explicit size |
| **Mono id/slug in table** | `font-mono text-xs text-muted-foreground` |
| **Button label** | via `<Button>` → `text-[13px] font-medium` (canonical Option-A signature) |
| **Button — small (xs)** | via `<Button size="xs">` → `text-xs` |
| **Badge / status chip** | via `<Badge>` → `text-[11px] font-medium` |
| **Form label** | via `<Label>` → `text-sm font-medium leading-none` |
| **Form helper / hint** | `text-xs text-muted-foreground` |
| **Sidebar nav item** | `text-[13px]` (Option-A signature, keep) |
| **Stat number (dashboard)** | `text-[26px] font-semibold leading-none tracking-tight` |
| **Empty state title / desc** | via `<EmptyState>` (already canonical) |
| **Breadcrumb** | `text-xs text-muted-foreground` (already canonical via `<PageShell>`) |

**Rule of thumb:** if you're setting `text-[10px]` or `text-[11px]` outside a Badge / eyebrow / avatar-initials context, switch to `text-xs`. Never introduce `text-[12px]` — go to `text-xs` (12px in the config actually equals 0.75rem = 12px, wait: xs = 0.75rem = 12px, sm = 0.875rem = 14px). Note: `text-xs` is 12px so `text-[12px]` is literally a duplicate.

---

## F. Fix plan (prioritized batches, DO NOT execute in this task)

### Batch 1 — Kill duplicated `text-[12px]` and `text-[10px]` meta text
**Files:** `app-shell.tsx`, `space-switcher.tsx`, `identify-as-dropdown.tsx`, `saved-searches-list.tsx`, `markdown-view.tsx`, `sidebar-user-card.tsx` (error line), `sidebar-nav.tsx` (nav count Badge override)
**Effort:** small, low-risk. Just replace `text-[10px]` / `text-[12px]` → `text-xs`.

### Batch 2 — Normalize eyebrow label
**Files:** `artifacts/[id]/artifact-detail-sidebar.tsx:44`, `artifacts/[id]/edit/page.tsx:113`, `artifacts/new/page.tsx:320`, `skills/[name]/page.tsx:116`
**Action:** unify all eyebrows to `text-[10px] font-semibold uppercase tracking-wider text-muted-foreground`. Skills page section header is currently size-`sm` — decide: is it an eyebrow or a full H2? If eyebrow → shrink to `text-[10px]`; if H2 → drop `uppercase tracking-wider`.

### Batch 3 — Collapse H1 sizes
**Files:** `search/page.tsx:202`, `artifacts/[id]/page.tsx:84`, `artifacts/review/page.tsx:37`
**Action:** decide `text-xl` vs `text-2xl` for hero pages. Two options:
- **Option (safe):** align to `text-xl font-semibold tracking-tight` (matches PageShell everywhere).
- **Option (hierarchy):** keep `text-2xl` for detail/hero pages, standardize `font-semibold tracking-tight` (kill `font-bold` in review page). Requires design intent decision.

### Batch 4 — Replace hand-rolled chips/buttons with components
**Files (list pages):**
- `app/skills/page.tsx` (4 chip patterns)
- `app/skills/[name]/page.tsx` (chip + action buttons)
- `app/artifacts/page.tsx` (Edit/Delete row actions)
- `components/dashboard-widgets-extra.tsx:115`
- `components/saved-searches-list.tsx:81`
- `app/profile/page.tsx:79`
- `app/artifacts/review/page.tsx:78` (CTA button)
- `app/artifacts/[id]/edit/page.tsx:119,134` (raw input + button)

**Action:** replace inline classes with `<Badge>` / `<Button size="xs">` / `<Input>`. Larger effort but high-value — reduces drift surface + ensures future scale changes work.

### Batch 5 — Table header consistency
**Files:** `app/skills/[name]/page.tsx:126-130`
**Action:** remove `text-xs` override on `<th>` — let it inherit `text-sm` like the other two tables. OR conversely, add `text-xs` to spaces + api-keys tables and pick that as canonical. Recommend inheriting `text-sm` (less code, more legible).

### Batch 6 — Form label consistency
**Files:** `app/artifacts/new/page.tsx:281,293,308,327`
**Action:** replace `<span className="text-sm font-medium">` with `<Label>` component.

### Batch 7 — Review page link title
**File:** `app/artifacts/review/page.tsx:67`
**Action:** align artifact title link to `text-sm font-medium text-foreground` (matching `artifacts/page.tsx:68` list-item title).

---

## Unresolved questions

1. **Hero H1 policy:** does OneMCP want a two-tier H1 (list = `text-xl`, detail/hero = `text-2xl`), or single-tier (`text-xl` everywhere)? Codebase splits 6:3 in favor of `text-xl`, but detail pages consistently break upward — this may be intentional for storytelling weight on a single artifact/search screen. **Design decision required.**
2. **Eyebrow size:** `text-[10px]` (7 usages) vs `text-xs` (2 usages `artifact-detail-sidebar`, `skills/[name]`). 10px reads as strong Linear signature; 12px is more accessible. Recommend 10px for consistency, but re-evaluate for a11y contrast on light theme.
3. **Skills-page section headline** (`skills/[name]/page.tsx:116`): currently `text-sm font-semibold uppercase tracking-wider text-muted-foreground` — sits between eyebrow (10px) and H2 (14px normal). Is it a stylistic override or unintentional? Recommend collapsing to eyebrow to reduce vocabulary.
4. **`text-[13px]` sidebar/form signature vs `text-sm` (14px):** the codebase mixes 13px (nav, buttons, inputs, pagination) with 14px (labels, body, cards). Is 13px reserved for "compact interactive controls" only? If so, this is coherent — but should be documented in `design-guidelines.md`.
5. **Avatar initials font size** (`sidebar-user-card.tsx:113`, `sidebar-brand.tsx:12`): `text-[11px]` — should we treat this as a "glyph" role (exempt from text scale) or normalize to `text-xs`?
