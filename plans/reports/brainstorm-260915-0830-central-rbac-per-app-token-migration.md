---
title: Central RBAC — Per-app Token Migration
type: brainstorm
created: 2026-09-15
status: approved (awaiting plan)
owner: platform-team
---

# Central RBAC — Migrate sang per-app token (Approach B)

## Problem statement

Central RBAC v2 (deployed 2026-09-14) hiện dùng **shared token** `CENTRAL_RBAC_RESOLVE_TOKEN` cho tất cả apps. Rủi ro:

1. Token leak 1 app → tất cả apps compromised → rotate toàn hệ thống
2. Không revoke được per-app khi app deprecate / dev rời team
3. Không audit rõ app nào gọi `/v2/resolve`
4. Không rate limit per-app (1 buggy app hammer → ảnh hưởng chung)

Vì **chưa có app nào register + Central chưa public** → cửa sổ vàng để migrate ít risk nhất.

## Requirements

**Functional**:
- Token phát riêng cho từng app (không shared)
- Multiple tokens per app (rotation-friendly, label='prod'/'staging'/'dev-alice')
- One-time reveal khi tạo — DB chỉ lưu hash
- Revoke per-token (soft-delete)
- Backward compat 3 tháng với legacy shared token
- UI CRUD trong Central Admin
- Audit log attach app_id

**Non-functional**:
- `/v2/resolve` p99 <200ms (giữ target hiện tại — argon2 verify cần cache in-memory)
- SDK non-breaking (config vẫn `centralRbacToken: string`)
- Secret scanner (gitleaks) detect được leak → prefix `rbac_`

## Approaches evaluated

| Approach | Pros | Cons | Chọn? |
|---|---|---|---|
| **A. Giữ shared token** | KISS, không dev | 4 rủi ro không giải quyết | ❌ |
| **B. Per-app token** | Revoke, audit, rate limit, blast radius nhỏ | +1 tuần dev, ops track N tokens | ✅ |
| **C. mTLS client cert** | Bảo mật cao nhất | Ops nightmare, YAGNI với <10 apps | ❌ |

## Final design (approved)

### Token format
```
rbac_<8char-prefix>_<24char-secret>
```
- Prefix `rbac_` → secret scanner detect leak
- 8-char base32 prefix → indexed lookup (không argon2-compare toàn bảng)
- 24-char base32 secret → 120 bits entropy
- Total ~40 chars, opaque (không JWT)

Ví dụ: `rbac_hj2kf9m8_kqr7x8v9w2n5c4b1d6h3p0`

### Schema — Migration 020
```sql
CREATE TABLE rbac.app_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES rbac.apps(id) ON DELETE CASCADE,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,            -- argon2id
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  UNIQUE (app_id, label) WHERE revoked_at IS NULL
);

CREATE INDEX idx_app_tokens_prefix_active
  ON rbac.app_tokens(token_prefix)
  WHERE revoked_at IS NULL;
```

### Auth flow (updated `auth-resolve.ts`)
```
X-Rbac-Token header
  ↓
Validate format regex ^rbac_[a-z0-9]{8}_[a-z0-9]{24}$
  ↓ match
Extract prefix → in-memory cache lookup (5 min TTL)
  ↓ cache miss
SELECT app_id, token_hash FROM app_tokens WHERE prefix=$1 AND revoked_at IS NULL
  ↓
argon2.verify(fullToken, hash) → attach request.appId
UPDATE last_used_at throttled (60s bucket)

Legacy fallback (3 tháng grace):
  Nếu không match rbac_* → constant-compare CENTRAL_RBAC_RESOLVE_TOKEN
  Match → allow + metric rbac_legacy_token_used_total + warn log
  Cutoff: 2028-01-01
```

### Wizard integration
Register app v2 → auto-gen 1 token label='prod':
```json
POST /v1/admin/apps → response:
{
  "id": "...",
  "slug": "helpdesk",
  "client_id": "...",
  "client_secret": "...",
  "rbac_token": "rbac_hj2kf9m8_xxx",  // ONE-TIME reveal
  "rbac_token_id": "..."
}
```

### UI page `/admin/apps/:slug/tokens`
- List active (prefix + label + created_at + last_used_at, không show secret)
- Create modal → response one-time reveal → copy button
- Revoke → soft-delete confirm dialog

### Rate limit — per-app bucket
```
Cũ: ratelimit:resolve:user:{sub}:{app_slug}:{window}
Mới thêm: ratelimit:resolve:app:{app_id}:{window}
```
Env `RESOLVE_APP_RPM=6000` default.

### Audit log context
Attach `app_id`, `app_slug`, `token_prefix` vào `context` field mỗi authz action.

### SDK — non-breaking (0.2.0 minor)
- Config API không đổi
- Optional warn nếu token không match `^rbac_` (nhắc dev)
- Docs update: lấy token từ wizard/token page

## Implementation considerations

### Performance
- argon2 verify ~50ms/call → **must cache in-memory** `Map<prefix, {hash, app_id, expiry}>` TTL 5 min
- Cache miss chỉ khi token mới hoặc cache expire → ~1 verify/token/5min
- Verify vẫn constant-time (argon2 native)

### Migration safety (chưa có consumer)
1. Migration 020 apply prod
2. Deploy Central dual-mode (rbac_* + legacy)
3. Deploy UI + wizard update
4. Update docs (onboarding, why-sdk, template .env.example)
5. Bump SDK 0.2.0
6. 2028-01-01: remove legacy path + drop env var

### Rủi ro
| Rủi ro | Mitigation |
|---|---|
| argon2 CPU spike | In-memory cache 5 min TTL |
| Prefix collision | 32^8 = 1T combos, xác suất ~0 với <1000 tokens |
| Token leak in logs | Pino redact list — chỉ log prefix |
| UI leak on reveal | Modal warn "copy ngay", copy button, disable X close |
| DB restore mất tokens | SOP: chạy `scripts/print-token-status.ts` sau restore |

## Success criteria

- Migration 020 apply prod không downtime
- Wizard register app mới → response chứa `rbac_token` one-time
- UI CRUD token hoạt động
- SDK 0.2.0 dùng token per-app → resolve success
- `/v2/resolve` p99 <200ms (verify không regress)
- Audit log query "app nào gọi resolve nhiều nhất" chạy được
- Rate limit per-app: 1 app hammer không affect apps khác
- Legacy shared token vẫn work trong 3 tháng grace (backward compat)

## Effort estimate

| Item | Effort |
|---|---|
| Migration 020 + rollback | 0.5d |
| Auth middleware update + cache | 1d |
| Token CRUD service + admin routes | 1d |
| Wizard integration | 0.5d |
| Rate limit per-app | 0.5d |
| Audit context extension | 0.5d |
| UI token management page | 2d |
| Docs update | 0.5d |
| Tests (unit + integration) | 1.5d |
| **Total** | **~8 days** (1 dev), có thể parallel → ~5d |

## Next steps / dependencies

- Chốt final approach (✅ done) → tạo implementation plan multi-phase
- Không có external dependency mới (argon2 npm package đã có sẵn ecosystem)
- Post-launch: publish SDK 0.2.0 khi bootstrap operators xong

## Unresolved questions

1. **argon2 vs bcrypt**: recommend argon2id (OWASP modern). Anh có preference?
2. **Token expiry TTL**: recommend không expire, revoke manual khi cần. Có muốn TTL default (VD 1 năm) không?
3. **`ip_allowlist` metadata cho token**: YAGNI-strip nếu chưa cần, có thể add sau. Chốt luôn hay để mở?
4. **Multiple envs auto-gen tại wizard**: recommend chỉ 1 prod token, admin tự tạo thêm khi cần. Có muốn auto-gen 3 (prod/staging/dev) không?
