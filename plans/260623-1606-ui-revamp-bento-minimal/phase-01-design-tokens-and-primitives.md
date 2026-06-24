# Phase 01 · Design tokens + UI primitives

**Priority:** P0 · **Status:** pending · **Depends on:** —

## Overview
Tạo nền móng styling: CSS variables theo mock, Tailwind theme extend, và 6 primitive components dùng chung cho cả chat + admin.

## Tokens (globals.css)
Update `web/src/app/globals.css`:
```css
:root {
  --bg: #0a0a0b;
  --card: #111114;
  --line: #1f1f25;
  --mut: #8a8a96;
  --fg: #ededf0;
  --acc: #7dd3fc;       /* cyan-300 */
  --good: #7ee2a8;
  --warn: #fbbf24;
  --err: #ef6f7d;
}
body { background: var(--bg); color: var(--fg); font-family: Inter, ui-sans-serif, system-ui; }
```
Map vào `tailwind.config.ts` `theme.extend.colors`: `bg, surface, line, muted, accent, good, warn, err`.

## Primitive components (new files)
Place trong `web/src/components/ui/`:
1. `card.tsx` — `<Card>` wrap div: bg surface, 1px border line, radius 14px.
2. `chip.tsx` — small pill: border, padding 1px 7px, font 11.
3. `bar.tsx` — `<Bar value={0..100} color?>` — track + fill.
4. `sparkline.tsx` — `<Sparkline points={number[]} />` — inline SVG path, viewBox auto-fit.
5. `dot.tsx` — `<Dot tone="good|warn|err|mut" />` — 6px round.
6. `kbd.tsx` — `<Kbd>⌘N</Kbd>` — keyboard hint style.

Mỗi file ≤ 40 lines. Re-export từ `components/ui/index.ts`.

## Acceptance
- [ ] `globals.css` & tailwind theme updated, build pass.
- [ ] 6 primitives compile, type-checked.
- [ ] Smoke render test: import + render mỗi primitive trong `app/page.tsx` test stub (xoá sau).

## Files
- modify: `web/src/app/globals.css`, `web/tailwind.config.ts`
- create: `web/src/components/ui/{card,chip,bar,sparkline,dot,kbd,index}.tsx`
