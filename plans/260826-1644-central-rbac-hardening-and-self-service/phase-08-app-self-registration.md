# Phase 08 — App Self-Registration (Permission Manifest)

## Context Links

- Brainstorm: `plans/reports/brainstorm-260826-1644-central-rbac-hardening-and-self-service.md` §3.3
- Research (manifest patterns): `plans/reports/researcher-260826-1644-central-rbac-mtls-and-manifest.md` Topic 2
- Predecessor plan (permission model): `plans/260821-1644-central-rbac-single-pane/plan.md`
- Memory: `onemcp-mirror-policy.md` (cross-repo edit rules for OneMCP endpoint)

## Overview

- **Priority:** P1
- **Status:** pending (blocked by Phase 07 apps admin API)
- **Duration:** 2 tuần
- **Brief:** App expose `/.well-known/rbac-permissions.json` (JSON + etag). Admin trigger sync via UI → central-rbac fetch + validate namespace + compute diff → 3-column diff UI (add / update-desc / deprecate) → admin approve items → apply to DB. Immutable keys, soft-delete only. OneMCP first adopter. App developer guide docs.

## Key Insights

- **PULL model chosen** (over PUSH) — admin controls sync timing, audit trail cleaner, handles offline apps gracefully
- **ETag for cache** — central-rbac stores last-seen etag per app; skip re-fetch if unchanged
- **Immutability rule** (from MVP) — permission key never deleted or semantic-changed; only `deprecated_at` timestamp + optional `alias_of` array
- **Namespace enforcement** — manifest MUST declare `service` field matching app_id; all permission ids MUST prefix with `{service}:` — reject cross-namespace at ingest
- **Schema version** — top-level `schema: "1"` field; frozen; v2 requires central-rbac code path
- **No hard delete** — deprecate soft, alias to replacement; supports historical audit queries
- **OneMCP integration is cross-project** — use `onemcp-mirror-policy.md` rules (commit via `git -C D:\Vietnt\Project\onemcp`)

## Requirements

### Functional

- FR-08.1: `POST /v1/admin/apps/:id/sync-manifest` fetches manifest via `manifest_url` (from Phase 07 wizard, or edited via Apps list "Edit manifest URL" UI). Fetcher HARDENED per Red Team Fix #2: HTTPS-only, resolve DNS once + pin IP for actual request, reject if resolved IP in RFC1918/loopback/link-local/169.254/multicast/IPv6-ULA, block HTTP redirects (or re-validate destination IP on each redirect), size cap 256KB, timeout 5s + 1 retry. If-None-Match cached etag sent.

    > **🔴 Red Team Fix #2 (Critical):** SSRF via manifest URL. No allow-list, no RFC1918 block, no IP pin in original plan → attacker sets `manifest_url` to `http://169.254.169.254/latest/meta-data/...` (cloud metadata) or `http://10.0.0.1/admin`. Fetcher MUST validate resolved IP and pin it against redirect bypass.
- FR-08.2: Fetch validates HTTP 200 + Content-Type JSON + max size 256KB + schema conformance (JSON schema)
- FR-08.3: Namespace validator (Red Team Fix #13): (a) every permission `id` MUST split on `:` and first segment MUST equal `{manifest.service}` EXACTLY (drop `startsWith` — prevents `onemcp` slug matching `onemcp-lab:foo`), (b) `manifest.service == app.slug` (case-insensitive equal, not prefix), (c) slug regex `^[a-z][a-z0-9]{2,31}$` enforced at wizard AND revalidated on sync, (d) slug prefix-collision globally rejected at wizard (Phase 07 cross-ref).
- FR-08.4: Immutability check: existing key MUST NOT change `description` semantic (allow only `[DEPRECATED]` prefix); rename via `alias_of` + new key
- FR-08.5: Diff computed vs DB state — 4 categories: `add` (new keys), `update-desc` (description non-semantic change), `explicit-deprecate` (manifest declares `status: soft-deleted`), `implicit-deprecate` (key missing from manifest — treated as unexpected deletion candidate). Diff response includes sha256 of full manifest body + etag (Red Team Fix #14 — TOCTOU pin). See Red Team Fix #9 for UI defaults.
- FR-08.12: Apply endpoint requires client to submit `manifest_sha256` matching the diff-time hash — server applies from cached copy indexed by sha256 (preferred) OR re-fetches + rejects if changed. Prevents TOCTOU between review and apply. See Red Team Fix #14.
- FR-08.6: Diff response returned to UI with per-item action + admin approval required for each
- FR-08.7: `POST /v1/admin/apps/:id/apply-manifest-diff` accepts list of approved item ids → applies as SQL transaction → audit row per item
- FR-08.8: Soft-delete = set `permissions.deprecated_at = NOW()` + optional `alias_of`; roles referencing deprecated permission remain valid (backward compat)
- FR-08.9: `rbac.manifest_sync_audit` table logs every sync attempt (who, when, etag, diff summary, applied count)
- FR-08.10: OneMCP `/.well-known/rbac-permissions.json` endpoint returns valid manifest for OneMCP permissions (`onemcp.*` namespace)
- FR-08.11: App developer guide docs written; covers manifest schema + hosting requirements + versioning

### Non-functional

- NFR-08.1: Fetch timeout 5s + 1 retry (total ≤10s user wait)
- NFR-08.2: Diff computation <500ms for manifest ≤200 permissions
- NFR-08.3: Apply transaction atomic (all-or-nothing per approve batch)
- NFR-08.4: Manifest schema documented externally (`docs/central-rbac-manifest-schema.md`) with JSON schema file publishable at `/.well-known/rbac-permissions-schema.json`

## Architecture

### Component diagram

```
+------------------------------+
| App (e.g., OneMCP backend)   |
|   ┌──────────────────────┐   |
|   │ GET /.well-known/    │   |
|   │  rbac-permissions.json│  |
|   │  → JSON + ETag       │   |
|   └──────────────────────┘   |
+------------------------------+
              ▲
              │ HTTPS fetch (server-to-server)
              │ If-None-Match: <cached etag>
              │
+-------------┼----------------------+
| central-rbac backend               |
|  ┌─────────────────────────────┐   |
|  │ routes/admin-apps-sync-      │   |
|  │  manifest.ts                 │   |
|  │   ├─ mfetch → manifest-fetcher│  |
|  │   │   ├─ etag cache check    │   |
|  │   │   ├─ HTTP fetch + retry  │   |
|  │   │   └─ schema validate     │   |
|  │   ├─ services/manifest-diff  │   |
|  │   │   ├─ namespace validate  │   |
|  │   │   ├─ immutability check  │   |
|  │   │   └─ compute add/upd/dep │   |
|  │   └─ return diff → UI        │   |
|  │                              │   |
|  │ POST apply-manifest-diff     │   |
|  │   ├─ tx: INSERT / UPDATE     │   |
|  │   │      permissions         │   |
|  │   └─ INSERT audit rows       │   |
|  └─────────────────────────────┘   |
+------------------------------------+
              ▲
              │ approve items
              │
+-------------┼----------------------+
| central-rbac-ui                    |
|  ┌─────────────────────────────┐   |
|  │ ManifestSyncPage            │   |
|  │  ├─ trigger sync button     │   |
|  │  ├─ ManifestDiff component  │   |
|  │  │   3-column: add / upd    │   |
|  │  │             / deprecate  │   |
|  │  │   checkbox per item      │   |
|  │  └─ apply approved button   │   |
|  └─────────────────────────────┘   |
+------------------------------------+
```

### Data flow (sync + apply)

1. Admin clicks "Sync manifest" on Apps list row → `POST /v1/admin/apps/:id/sync-manifest`
2. Backend loads app record → gets `manifest_url` + cached `manifest_etag`
3. Manifest-fetcher: HTTPS GET with `If-None-Match` → 304 (return "no changes") OR 200 (fetch body + new etag)
4. Schema validate → namespace validate → immutability check
5. Load current DB permissions for `{app_id}` namespace
6. Compute diff → return JSON structure `{additions: [...], updates: [...], deprecations: [...], errors: []}`
7. UI renders 3-column diff with checkbox per item (default ALL checked)
8. Admin unchecks unwanted → clicks "Apply approved"
9. `POST /v1/admin/apps/:id/apply-manifest-diff` with `{approved_ids: [...]}`
10. Backend tx: INSERT new perms, UPDATE descriptions, SET deprecated_at for deprecations
11. INSERT `rbac.manifest_sync_audit` rows (per item)
12. Update app record with new `manifest_etag`
13. Return summary → UI success screen

## Related Code Files

### Create (central-rbac)

- `central-rbac/src/routes/admin-apps-sync-manifest.ts` — POST sync + POST apply
- `central-rbac/src/services/manifest-fetcher.ts` — fetch + etag + retry + schema validate
- `central-rbac/src/services/manifest-diff.ts` — namespace validate + immutability check + diff compute
- `central-rbac/src/services/manifest-schema.ts` — JSON schema definition (single source, exposed via /.well-known)
- `central-rbac/src/db/migrations/009_manifest_sync_audit.sql` — audit table; **extends OneLog hash-chain (reuse `003_audit_hash_chain.sql` + `004_audit_immutable_trigger.sql`)** — each row has prev_hash + current_hash; DENY UPDATE/DELETE at DB role. See Red Team Fix #12. (Numbering: 005/006/007 taken.)
- `central-rbac/src/db/migrations/010_permissions_deprecation.sql` — add `deprecated_at`, `alias_of` (jsonb array), `manifest_url` on `rbac.apps` (nullable — allows retrofit for pre-Phase-07 apps), `manifest_etag` on `rbac.apps`. See Red Team Fix #15.
- `central-rbac/src/routes/well-known-manifest-schema.ts` — expose schema at `/.well-known/rbac-permissions-schema.json`
- `central-rbac/tests/manifest-diff.unit.test.ts` — 6+ cases (happy, namespace violation, immutability violation, alias, deprecation, etag)
- `central-rbac/tests/manifest-sync.integration.test.ts` — full flow with mock app server

### Create (UI)

- `central-rbac-ui/src/pages/manifest-sync-page.tsx`
- `central-rbac-ui/src/components/manifest-diff.tsx` — 3-column visual diff
- `central-rbac-ui/src/api/manifest-sync-api.ts` — typed client

### Create (OneMCP — cross-project per `onemcp-mirror-policy.md`)

- `onemcp/backend/src/routes/well-known-rbac-permissions.ts` — static route serving OneMCP manifest with ETag header
- `onemcp/backend/src/config/rbac-permissions-manifest.json` — canonical source (git-tracked)
- `onemcp/docs/rbac-manifest.md` — OneMCP-specific doc

### Create (docs)

- `docs/central-rbac-manifest-schema.md` — schema reference + examples + versioning policy
- `docs/central-rbac-app-developer-guide.md` — how to expose manifest, hosting requirements, migration examples

### Modify

- `central-rbac/src/db/schema.ts` — reference new migrations
- `central-rbac/src/app.ts` — register routes
- `central-rbac-ui/src/pages/apps-list-page.tsx` (from Phase 07) — add "Sync manifest" button per row
- `central-rbac-ui/src/App.tsx` — route `/admin/apps/:id/sync-manifest`
- OneMCP `backend/src/app.ts` — register well-known route

## Implementation Steps

1. **Schema definition** — write `manifest-schema.ts` exporting JSON schema (draft-07). Fields: `schema` (const "1"), `service` (kebab-case), `version` (semver or date), `permissions` (array), `default_roles` (optional array). Publish at `/.well-known/rbac-permissions-schema.json` in central-rbac.
2. **DB migration 009** — `manifest_sync_audit` table: `id, app_id, admin_sub, sync_type (fetch/apply), etag_seen, diff_summary jsonb, result, item_details jsonb, created_at`.
3. **DB migration 010** — ALTER `rbac.permissions` ADD `deprecated_at timestamptz`, ADD `alias_of jsonb`, ADD `manifest_url text` on `rbac.apps`, ADD `manifest_etag text` on `rbac.apps`. If columns exist, skip.
4. **Manifest fetcher (SSRF-hardened)** — `manifest-fetcher.ts`: (a) reject non-HTTPS scheme, (b) resolve DNS once via `dns.resolve4/6`, (c) reject if resolved IP matches RFC1918 (10/8, 172.16/12, 192.168/16), loopback (127/8, ::1), link-local (169.254/16, fe80::/10), multicast, IPv6-ULA (fc00::/7), (d) build axios request with `lookup` option that returns pinned IP (prevents rebinding), (e) `maxRedirects: 0` — on redirect, re-validate destination via same IP checks, (f) 5s timeout + 1 retry, (g) Content-Type must be `application/json`, size ≤256KB. Return `{status: "not-modified" | "fetched", etag, body, sha256}`. See Red Team Fix #2.
5. **Namespace validator (exact-segment match)** — reject if `manifest.service.toLowerCase() !== app.slug.toLowerCase()` (case-insensitive exact, NOT startsWith). For each `permission.id`: split on `:` — first segment MUST equal `manifest.service` EXACTLY (prevents `onemcp` slug matching `onemcp-lab:foo` cross-namespace). Slug regex revalidate `^[a-z][a-z0-9]{2,31}$`. Return specific error array (per item). See Red Team Fix #13.
6. **Immutability check + implicit-deprecation flagging** — for each existing DB permission with matching id: `description` change allowed only if new starts with `[DEPRECATED]` prefix; else error. If manifest omits existing key AND doesn't mark deprecated → categorize as `implicit-deprecate` (separate from `explicit-deprecate`) — will be flagged in diff UI as "unexpected deletion" with WARNING banner (Red Team Fix #9). Diff UI defaults for `implicit-deprecate` = UNCHECKED (safer default; prevents typo bug wiping perms); explicit deprecations may default checked.
7. **Diff computer** — `manifest-diff.ts`: compare manifest permissions vs DB permissions for app namespace. Categorize: `add` (in manifest, not in DB), `update-desc` (in both, description differs), `deprecate` (in DB active, in manifest marked `status: soft-deleted` OR missing entirely). Include `alias_of` if manifest declares.
8. **Sync endpoint** — `POST /v1/admin/apps/:id/sync-manifest`: load app (must have `manifest_url` set) → SSRF-hardened fetcher → validators → diff → cache manifest body server-side indexed by sha256 (TTL 1h) → INSERT audit row (fetch type, includes sha256) → return diff JSON with `manifest_sha256` field. Cache etag on 200.
9. **Apply endpoint (sha256-pinned)** — `POST /v1/admin/apps/:id/apply-manifest-diff` body `{manifest_sha256, approved_ids: [{action, id}]}`: server looks up cached manifest by sha256 → 409 if not found or expired (client must re-review). If found: SQL transaction — INSERT new perms, UPDATE descriptions, SET deprecated_at for BOTH `explicit-deprecate` AND `implicit-deprecate` (only if admin actively checked; default UNCHECKED for implicit). INSERT audit rows (apply type, per item, hash-chained). Return summary. See Red Team Fix #14 + #9.
10. **Unit tests** — 6+ cases for diff logic; cover edge cases (empty manifest, all-new app first sync, alias chain).
11. **Integration test** — spawn mock HTTP server serving fixture manifest; run sync + apply; assert DB state.
12. **UI ManifestSyncPage** — 2 states: (a) trigger sync button + last-sync info, (b) diff view. Load diff via `POST /sync-manifest`, render 3 columns with checkboxes.
13. **ManifestDiff component (4 categories, safe defaults per Fix #9)** — columns: green (add, default CHECKED), yellow (update-desc, default CHECKED), orange (explicit-deprecate, default CHECKED), red (implicit-deprecate, **default UNCHECKED + warning banner "unexpected removal detected — verify app-side change was intentional before applying"**). Per-row checkbox + description tooltip. "Select all" per column. Store `manifest_sha256` from sync response; include in apply request.
14. **Apps list "Sync" + "Edit manifest URL" buttons** — Phase 07 apps-list-page.tsx: add column with 2 buttons per row: (a) "Sync manifest" → navigate to `/admin/apps/:id/sync-manifest`, (b) "Edit manifest URL" → inline dialog with HTTPS + public DNS validation (for existing apps that didn't set URL in wizard, or need URL change). See Red Team Fix #15.
15. **OneMCP manifest source** — write `onemcp/backend/src/config/rbac-permissions-manifest.json` with current OneMCP permissions (extract from existing hardcoded list). Verify per `onemcp-mirror-policy.md` chế độ B (cook cross-project allowed).
16. **OneMCP endpoint** — `well-known-rbac-permissions.ts` route: serve JSON with `ETag: <sha256>`, `Cache-Control: max-age=300`. Register in OneMCP backend app.
17. **OneMCP commit** — `git -C D:\Vietnt\Project\onemcp` add + commit + push per `onemcp-mirror-policy.md`. Message: `feat(rbac): expose /.well-known/rbac-permissions.json manifest` + refs onelog plan.
18. **OneMCP deploy** — via onemcp-vps sync policy (host-sync-policy).
19. **End-to-end lab test** — deploy central-rbac to onelog-source lab; deploy OneMCP with manifest to onemcp-source lab; run sync from central-rbac UI against OneMCP manifest URL; validate diff shows all OneMCP permissions as "add"; apply; verify DB.
20. **App developer guide** — `docs/central-rbac-app-developer-guide.md`: cover manifest schema, hosting (static file OR dynamic endpoint), etag, versioning, deprecation workflow, examples (OneMCP as reference).
21. **Manifest schema doc** — `docs/central-rbac-manifest-schema.md`: field-by-field reference + JSON schema link + immutability rules.
22. **Prod deploy central-rbac** — host-sync-policy compliant.
23. **Prod smoke** — sync OneMCP prod manifest → apply → verify RBAC resolve still works for existing users (backward compat critical).

## Todo List

- [ ] 1. Schema definition + JSON schema publish endpoint
- [ ] 2. DB migration 009 (audit table)
- [ ] 3. DB migration 010 (deprecation + manifest_url/etag columns)
- [ ] 4. Manifest fetcher (SSRF-hardened: HTTPS + DNS pin + IP allowlist + no-redirect)
- [ ] 5. Namespace validator (exact-segment match on `:` split; slug regex)
- [ ] 6. Immutability checker + implicit-vs-explicit deprecation categorizer
- [ ] 7. Diff computer (4 categories: add/update-desc/explicit-dep/implicit-dep + sha256)
- [ ] 8. POST /sync-manifest endpoint (cache manifest body by sha256, TTL 1h)
- [ ] 9. POST /apply-manifest-diff endpoint (sha256-pinned, cached-copy lookup)
- [ ] 10. Unit tests diff logic (incl. SSRF, TOCTOU, namespace exact-match, implicit-dep)
- [ ] 11. Integration test full flow
- [ ] 12. UI ManifestSyncPage
- [ ] 13. UI ManifestDiff component (4 columns, implicit-dep DEFAULT UNCHECKED + warning banner)
- [ ] 14. Apps list "Sync" + "Edit manifest URL" buttons (Phase 07 mod)
- [ ] 15. OneMCP manifest JSON (canonical source)
- [ ] 16. OneMCP well-known endpoint
- [ ] 17. OneMCP commit + push (cross-repo)
- [ ] 18. OneMCP deploy prod
- [ ] 19. E2E lab test
- [ ] 20. App developer guide docs
- [ ] 21. Manifest schema reference docs
- [ ] 22. Prod deploy central-rbac
- [ ] 23. Prod smoke + backward compat verify (OneMCP re-register as adopter #1; adopter #2 deferred per Decision A)

## Success Criteria

- OneMCP `/.well-known/rbac-permissions.json` returns valid manifest with ETag header (200 fresh, 304 cached)
- Admin syncs OneMCP manifest via UI, sees diff, applies selected items, DB updates match approved list
- Existing user permission resolution unchanged after sync (backward compat via soft-delete)
- Cross-namespace manifest (e.g., OneMCP declares `foo:bar`) → sync fails with clear error msg
- Immutability violation (existing key description semantic change) → sync fails, listed in errors array
- **OneMCP re-registers as adopter #1 via manifest end-to-end** (via Phase 07 wizard `manifest_url` field pointing to OneMCP `/.well-known/rbac-permissions.json`, sync UI shows OneMCP perms as "add" diff, apply persists) — Decision A: adopter #2 true validation deferred to follow-up plan
- SSRF fetcher rejects `manifest_url=http://169.254.169.254/...` (metadata) and `http://10.0.0.1/...` (RFC1918) with clear error msg
- TOCTOU test: sync produces sha256 X; attacker modifies manifest between review + apply; apply with old sha256 → server returns cached copy (safe) OR re-fetch detects change and 409s
- Namespace exact-segment test: app slug `onemcp` rejects manifest permission id `onemcp-lab:foo` (previously `startsWith` would have accepted)
- Implicit deprecation UI: manifest missing existing key → shows in red column with warning banner + default UNCHECKED

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Apply tx fails mid-way → partial state | Low | High | Single SQL transaction with rollback; audit row includes final state; retry idempotent (upsert semantics) |
| App ships permission bug (typo) → admin approves blindly → wrong perm | Medium | Medium | Diff UI highlights new keys prominently; require checkbox confirmation per item; alias_of clearly shown |
| Manifest URL DNS/network fail | Medium | Low | Timeout + retry; clear error to admin; last-good etag preserved |
| Attacker MITM manifest URL → poison perms | Low | High | Fetch MUST use HTTPS (enforce in fetcher); pinned CA optional (Phase 09); admin approval gate is defense in depth |
| Manifest schema v1 breaking change needed | High | High | Schema version frozen; introduce v2 as parallel format; app declares `schema: "2"` → separate code path |
| Deprecate cascade breaks live users | Medium | High | Soft-delete only; alias_of preserves resolve behavior; RBAC resolve endpoint tolerates deprecated permissions in existing role bindings |
| OneMCP endpoint exposes to public without auth | Low | Low | Manifest is public info (permission names, no secrets); acceptable exposure; document as such |

## Security Considerations

- **SSRF-hardened fetcher (Fix #2):** HTTPS-only (dev localhost env-gated), DNS resolved ONCE with pinned IP for request, reject RFC1918/loopback/link-local/multicast/IPv6-ULA, redirects blocked or destination re-validated, size cap 256KB, timeout 5s
- No JS execution during parse (JSON.parse only, no `eval`)
- **Namespace enforcement (Fix #13):** exact-segment match on `:` split (drop `startsWith`); slug regex `^[a-z][a-z0-9]{2,31}$` enforced; slug prefix-collision globally rejected at wizard
- **TOCTOU protection (Fix #14):** apply endpoint requires `manifest_sha256` matching diff-time hash; server uses cached copy indexed by sha256 (TTL 1h) or re-fetches + 409s on mismatch
- **Implicit deprecation safe default (Fix #9):** manifest omitting existing key → red column, warning banner "unexpected removal", default UNCHECKED — prevents app-side typo bug from wiping perms
- Admin approval per-item — no "auto-apply all" shortcut
- **Audit hash-chained (Fix #12):** rows extend OneLog migrations 003/004; DB role DENY UPDATE/DELETE; before/after snapshot in jsonb
- Manifest URL stored server-side per app (from wizard Phase 07 or "Edit manifest URL" UI) — not client-controllable per sync call
- Deprecated permissions remain in RBAC resolve output (backward compat) but flagged in admin UI
- Cross-project git commits (OneMCP) follow `onemcp-mirror-policy.md` — commit in absolute path `D:\Vietnt\Project\onemcp`, not junction

**Out of scope (follow-up):** Ship audit stream to append-only sink (S3 object-lock) — noted per Fix #12; not this plan.

## Rollback Plan

- **Diff computation bug produces wrong actions** → don't apply; disable sync route via feature flag; fix + redeploy
- **Apply tx corrupts data** → migration 009/010 audit table has before/after snapshots (jsonb) → restore script `scripts/restore-perms-from-audit.ts <sync_id>`
- **OneMCP endpoint 500s** → central-rbac skips sync gracefully; admin sees "app unreachable"; OneMCP-side rollback via `git -C D:\Vietnt\Project\onemcp revert HEAD`
- **Schema v1 wrong design** → introduce v2 parallel; deprecate v1 announcement; migration guide

## Next Steps (post-Phase 08)

- **Adopter #2 true validation (deferred per Decision A)** — follow-up plan: onboarding external app using wizard (Phase 07) + manifest (Phase 08) end-to-end; measures <30min dev time; validates docs quality
- Monitoring: dashboard for sync frequency + failed syncs + manifest staleness (>30d)
- Future Phase 09 candidates: CLI tool `rbac-cli sync`; auto-sync cron per app opt-in; Vault PKI migration when scale demands
- OneDocs integration: auto-generate permission reference docs from central-rbac DB (feed to OneDocs portal)
