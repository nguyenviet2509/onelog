# Phase 04 Report — Project entity + migration

**Plan:** 260807-1515-onemcp-connector-zitadel-independent  
**Status:** DONE  
**Commit:** `a500abb` — feat(projects): add Project entity + token cipher for multi-project registry (P4)

## Files Created

| File | Lines | Notes |
|---|---|---|
| `backend/src/projects/entities/project.entity.ts` | 79 | All schema fields, typed enums, FK relations |
| `backend/src/db/migrations/1722100000000-projects.ts` | 41 | up + down, 5 indexes |
| `backend/src/projects/projects.module.ts` | 13 | skeleton, exports ProjectsService |
| `backend/src/projects/projects.service.ts` | 19 | stub findAll/findOne; CRUD in P6 |
| `backend/src/common/crypto/token-cipher.service.ts` | 85 | AES-256-GCM, boot guard for prod |
| `backend/src/common/crypto/crypto.module.ts` | 10 | @Global, exports TokenCipherService |

## Files Modified

| File | Change |
|---|---|
| `backend/src/app.module.ts` | +imports CryptoModule, ProjectsModule |
| `backend/src/db/data-source.ts` | +Project entity in entities[] array |

## Schema vs spec delta

- Phase-04 spec had `owner_id INT NULL` (no FK constraint listed) — added FK to `users(id) ON DELETE SET NULL` to match entity pattern (consistent with skills/departments).
- Phase-04 spec had `approved_by INT NULL` — same FK treatment.
- `deploy_token_enc` stored as `BYTEA` in DB (matches spec); entity maps to `Buffer | null`.
- Added `rejected_reason TEXT` (in spec schema, not listed separately in phase file).
- Added `scope` index — query pattern for filtering public projects.

## Encryption design

- Format: `iv:ciphertext:tag` (3 base64 segments joined by `:`), stored as VARCHAR/text in entity but BYTEA column in DB.
- Dev fallback: zero-key + warning when `ONEMCP_ENCRYPTION_KEY` absent and `NODE_ENV !== production`.
- Prod boot guard: throws hard if key missing or not exactly 32 bytes decoded.

## Compile status

`npm run build` (nest build) — PASS, zero errors/warnings.

## Migration run

Not run against live DB this session — lab (`onemcp-source`) sync needed before `pnpm migration:run`. Phase-04 todo item "Local migration run" deferred to deployer.

## Unresolved

- `deploy_token_enc` column is `BYTEA` in DB but the entity uses `Buffer | null` mapped from bytea. The cipher output is a string (`iv:ct:tag`). Caller must do `Buffer.from(cipherService.encrypt(token))` before saving and `.toString()` before decrypting. P6 service should encapsulate this — no leaky boundary until then.
- `SavedSearch` entity not in data-source.ts entities[] (pre-existing gap, not introduced by P4).
