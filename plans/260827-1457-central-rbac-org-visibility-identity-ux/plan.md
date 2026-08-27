---
title: "Central RBAC Org visibility + Admin identity UX"
description: "Surface Zitadel org in users list/drawer/grant dialog + fix header showing raw userId. Lazy Redis-cached org enrichment, no rbac.orgs table."
status: pending
priority: P2
effort: 6h
branch: master
tags: [central-rbac, ui-ux, zitadel, admin, backend-enrichment]
created: 2026-08-27
name: Central RBAC Org visibility + Admin identity UX
slug: central-rbac-org-visibility-identity-ux
date: 2026-08-27
mode: fast
blockedBy: []
blocks: []
related:
  - 260826-1644-central-rbac-hardening-and-self-service
brainstorm: plans/reports/brainstorm-260827-1457-central-rbac-org-visibility-identity-ux.md
---

## Overview

Fix 2 UX concerns từ Phase 07/08 e2e session:
1. **Org invisible** — users list/drawer/grant dialog không hiện org name → admin nhầm cross-org grants.
2. **Header UI ugly** — top-right hiện raw Zitadel `sub` (387657093185798148) thay vì display_name.

Reuse `apps.zitadel_org_id` từ Migration 012 (session 260826). Backend lazy-fetch Zitadel org qua Redis cache 5min. UI decode JWT claim cho profile display.

**YAGNI**: không tạo `rbac.orgs` table, không cron sync. Nếu scale org > 20 hoặc rename thường xuyên thì upgrade sau.

## Phases

| # | File | Status | Effort | Description |
|---|------|--------|--------|-------------|
| 01 | [phase-01-backend-org-enrichment.md](phase-01-backend-org-enrichment.md) | pending | 1.5h | Backend: zitadel-org-client + enrich `/v1/users`, `/v1/users/:id`, `/v1/projects` responses với org.name |
| 02 | [phase-02-wizard-write-org.md](phase-02-wizard-write-org.md) | pending | 30m | Wizard `POST /v1/admin/apps` extract `resourceOwner` từ Zitadel addProject response → INSERT `rbac.apps.zitadel_org_id` |
| 03 | [phase-03-ui-org-display-identity.md](phase-03-ui-org-display-identity.md) | pending | 3h | UI: org column users list, drawer badge, grant dialog project→role filter, header profile dropdown |

## Key dependencies

- Migration 012 `apps.zitadel_org_id` column ✅ (đã applied 260827)
- Zitadel Management API `/management/v1/orgs/:id` GET endpoint
- JWT decode: dùng lib `jwt-decode` (nếu chưa có → npm install) hoặc atob split.

## Success criteria

- Users list: column "Tổ chức" hiện org name cho mọi user.
- Drawer: badge org dưới email; grant rows hiện project name.
- Grant dialog: chọn project → role list filter theo project. Submit disable đến khi đủ.
- Header: hiện display_name + avatar initial + dropdown Đăng xuất.
- Regression clean: grant/revoke Spike Tester `onemcp.admin` OK sau refactor.

## Files impacted

Backend (~4):
- `central-rbac/src/lib/zitadel-org-client.ts` **new**
- `central-rbac/src/routes/users.ts`
- `central-rbac/src/routes/projects.ts`
- `central-rbac/src/routes/admin-apps.ts`

UI (~6):
- `central-rbac-ui/src/lib/types.ts`
- `central-rbac-ui/src/hooks/use-me.ts` **new**
- `central-rbac-ui/src/pages/users/users-list-page.tsx`
- `central-rbac-ui/src/pages/users/user-detail-drawer.tsx`
- `central-rbac-ui/src/pages/users/grant-dialog.tsx`
- `central-rbac-ui/src/components/layout/sidebar.tsx`

## Deploy pattern

Per host-sync-policy: tar-over-ssh sang authway-vps `/opt/central-rbac`, docker compose build + up.
