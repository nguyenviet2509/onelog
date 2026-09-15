# central-rbac/scripts

Operational scripts for Central RBAC backend.

| Script | When to run | Command |
|---|---|---|
| `migrate.ts` | Apply pending SQL migrations | `npm run migrate` |
| `bootstrap-dev.ts` | Seed dev DB (idempotent) | `npm run bootstrap-dev` |
| `bootstrap.ts` | Bootstrap prod (bootstrap admin) | `npm run bootstrap` |
| `019-bootstrap-operators.ts` | Seed `central.operator` grants post-migration 019 | `CENTRAL_OPERATOR_SUBS=<csv> npm run bootstrap-operators` |
| `backfill-user-grants-from-zitadel.ts` | One-time backfill Zitadel grants → `rbac.user_grants` (plan 260915-1615 phase 1) | `npm run backfill-user-grants -- --dry-run` |

## backfill-user-grants-from-zitadel.ts

Sync historical grants từ Zitadel về `rbac.user_grants` — cần chạy 1 lần post-deploy phase 1
để existing users có mirror trong DB (SDK `/v2/resolve` mới thấy permissions).

Idempotent (WHERE NOT EXISTS) — safe re-run. Skip roles không tồn tại trong `rbac.roles`.

**Usage:**

```bash
# 1. Dry-run trước (log intended INSERTs, no writes)
WRITER_DATABASE_URL=postgresql://... \
ZITADEL_MGMT_HOST=https://... \
ZITADEL_SERVICE_ACCOUNT_KEY_PATH=/path/to/sa.json \
  npm run backfill-user-grants -- --dry-run

# 2. Verify counts match expected → apply
WRITER_DATABASE_URL=postgresql://... \
ZITADEL_MGMT_HOST=https://... \
ZITADEL_SERVICE_ACCOUNT_KEY_PATH=/path/to/sa.json \
  npm run backfill-user-grants -- --apply
```

**Output:**

```
=== onelog-agent (327103181234567890) ===
  3 grants từ Zitadel
  INSERT 389119521513799683 → onelog-agent.viewer
  INSERT 389119521513799683 → onelog-agent.admin
  ...

=== REPORT ===
{
  "apps_scanned": 8,
  "apps_skipped_no_project": 0,
  "grants_processed": 42,
  "rows_inserted": 40,
  "skipped_conflict": 2,
  "skipped_no_role": 0,
  "errors": 0
}
```

**Rollback:** `DELETE FROM rbac.user_grants WHERE granted_by_sub = 'backfill' AND created_at > '<deploy_ts>'`
— backfill idempotent, safe to re-run.
