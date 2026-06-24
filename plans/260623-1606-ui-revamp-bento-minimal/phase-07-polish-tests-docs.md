# Phase 07 · Polish, tests, docs

**Priority:** P1 · **Status:** pending · **Depends on:** Phase 01–06

## Overview
Hoàn thiện UI edge cases, viết tests core paths, cập nhật docs.

## Polish checklist
- [ ] Loading skeletons cho admin cards (pulse bg variant).
- [ ] Empty states: "No data for selected range" khi range trả 0 row.
- [ ] Error toast/banner khi endpoint fail (component `<ErrorBanner>` đơn giản).
- [ ] Number formatting helper `lib/fmt.ts`: `fmtNum(1284) → "1,284"`, `fmtCost(94100000) → "$94.10"`, `fmtMs(3400) → "3.4s"`, `fmtBytes`.
- [ ] Color tone consistency check (good/warn/err) — chỉ dùng từ token, không hardcode hex trong components.
- [ ] Scrollbar styled (đã có baseline trong globals.css).
- [ ] Keyboard: `⌘K` mở conversation search (basic — focus sidebar input).

## Tests (vitest)
Setup `web/vitest.config.ts` nếu chưa có. Add dev dep `vitest`, `@testing-library/react`.

Test priority:
1. `lib/admin/range.ts` — parse 24h/7d/30d, invalid throws.
2. `lib/instrumentation.ts` — cost calc với pricing fixture.
3. `lib/alerts/dedupe.ts` — không double-fire khi alert open.
4. API integration: `metrics/overview` returns shape đúng với fixture data (seed 50 llm_calls).
5. Component smoke: `<KpiCard>`, `<TokenUsageChart>` render với mock data.

Target coverage ≥ 60% cho `lib/` và new admin components.

## Docs updates
- `docs/system-architecture.md`: add section "Metrics & Alerts" mô tả tables mới + endpoint map.
- `docs/code-standards.md`: ghi convention component admin (file ≤ 80 LOC, Card primitive only).
- `docs/development-roadmap.md`: tick UI revamp DONE.
- `docs/project-changelog.md`: entry mới.
- `docs/deployment-security.md` (new, ngắn): IP allowlist note cho `/admin/*` endpoints, future TODO middleware auth.

## Acceptance
- [ ] `npm run build` pass, no TS errors.
- [ ] `npm run test` pass.
- [ ] All admin pages có loading + empty + error state.
- [ ] Docs updated, cross-links valid.
- [ ] Visual QA: chat + admin so với mock, screenshot diff < 10%.

## Files
- create: `web/src/lib/fmt.ts`, `web/src/components/ui/{skeleton,error-banner,empty-state}.tsx`
- create: `web/vitest.config.ts` + `web/src/lib/**/*.test.ts` + `web/src/components/admin/**/*.test.tsx`
- modify: `docs/*.md` (5 files)
- create: `docs/deployment-security.md`
