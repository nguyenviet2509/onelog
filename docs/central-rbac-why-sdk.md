# Central RBAC — Vì sao dùng SDK?

Reference cho app dev / member khi tích hợp Central RBAC vào app mới.
Trả lời câu hỏi: **"Nếu không dùng `@onelog/central-rbac-client`, tôi phải tự viết gì?"**

Cross-reference: [central-rbac-app-onboarding.md](central-rbac-app-onboarding.md) · [central-rbac-v1-vs-v2-workflow.md](central-rbac-v1-vs-v2-workflow.md)

---

## Tách 2 concern trước

"Auth" gồm 2 thứ, mức độ phức tạp khác nhau:

1. **AuthN (Authentication)** — verify "user là ai" → Zitadel OIDC (SDK **không** giải quyết, apps luôn phải setup)
2. **AuthZ (Authorization)** — check "user được làm gì" → Central RBAC, đây là chỗ SDK giúp

Không có SDK = phần **AuthZ** app dev phải tự viết. Phần AuthN vẫn dùng thư viện OIDC chuẩn
(`openid-client`, `passport-openidconnect`) — không đổi.

---

## Không có SDK, app dev phải tự làm 7 việc

### 1. HTTP client gọi `/v2/resolve` (~30 LOC)

```typescript
async function callResolve(userSub: string, tenantId: string | null) {
  const res = await fetch(`${CENTRAL_URL}/v2/resolve`, {
    method: 'POST',
    headers: {
      'X-Rbac-Token': RBAC_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_sub: userSub, app_slug: APP_SLUG, tenant_id: tenantId }),
    signal: AbortSignal.timeout(3000),
  });
  if (res.status === 429) throw new RateLimitError(res.headers.get('Retry-After'));
  if (!res.ok) throw new CentralError(res.status);
  return res.json();
}
```

**Rủi ro sai**: không set timeout → hang forever. Retry naive → thundering herd khi Central down.

### 2. LRU cache + invalidation (~50 LOC)

```typescript
const cache = new LRUCache<string, ResolveResponse>({ max: 10_000, ttl: 60_000 });

function cacheKey(userSub, tenantId, epoch) {
  return `${userSub}:${tenantId ?? 'global'}:e${epoch}`;
}

async function resolveWithCache(userSub, tenantId) {
  const epoch = await getEpoch();
  const key = cacheKey(userSub, tenantId, epoch);
  const cached = cache.get(key);
  if (cached) return cached;
  const fresh = await callResolve(userSub, tenantId);
  cache.set(key, fresh);
  return fresh;
}
```

**Rủi ro**: quên epoch trong cache key → cache stale khi permission thay đổi → user bị revoke vẫn access.

### 3. Epoch poller background (~40 LOC)

```typescript
let currentEpoch = 0;
setInterval(async () => {
  try {
    const res = await fetch(`${CENTRAL_URL}/v2/epoch/${APP_SLUG}`, {
      headers: { 'X-Rbac-Token': RBAC_TOKEN },
      signal: AbortSignal.timeout(2000),
    });
    const { epoch } = await res.json();
    if (epoch > currentEpoch) {
      currentEpoch = epoch;
      cache.clear();
    }
  } catch (err) { /* log, không throw */ }
}, 10_000).unref();
```

**Rủi ro**: quên `unref()` → process không exit khi shutdown. Cache clear aggressive → cache stampede.

### 4. Circuit breaker (~80 LOC)

3 state: closed → open (Central down) → half-open (thử probe). Tránh hammer Central khi nó đã sập.

```typescript
class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private openedAt = 0;

  async call(fn) {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < 30_000) throw new CircuitOpenError();
      this.state = 'half-open';
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() { this.failures = 0; this.state = 'closed'; }
  private onFailure() {
    this.failures++;
    if (this.failures >= 5) { this.state = 'open'; this.openedAt = Date.now(); }
  }
}
```

**Rủi ro không có**: Central down → mỗi request timeout 3s → app latency tăng → thread pool cạn → app cũng sập theo. **Cascade failure**.

### 5. Fail-close policy trong prod (~10 LOC)

```typescript
async function requirePermission(userSub, permission, tenantId) {
  try {
    const res = await resolveWithCache(userSub, tenantId);
    return res.permissions.includes(permission);
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      throw new AuthError('RBAC unavailable, deny by default');
    }
    console.warn('RBAC down in dev, allowing:', err);
    return true;
  }
}
```

**Rủi ro cực nghiêm trọng nếu quên**: Central down → fail-open → **ai cũng thành admin**. Đây là security hole **class-A**. Industry đã có bug prod nhiều lần vì cái này.

### 6. Tenant extractor per route (~20 LOC × N routes)

```typescript
app.get('/tickets', async (req, reply) => {
  const userSub = req.user.sub;
  const tenantId = req.query.dept as string;
  const allowed = await requirePermission(userSub, 'helpdesk:tickets.list', tenantId);
  if (!allowed) return reply.code(403).send({ error: 'forbidden' });
  // business logic
});

app.post('/tickets', async (req, reply) => {
  const userSub = req.user.sub;
  const tenantId = req.body.dept as string;
  // ... lặp lại
});
```

**Rủi ro**: mỗi route dev tự extract → dễ typo, quên tenant → grant global chấp nhận grant tenant-scoped → **privilege escalation**.

### 7. Webhook receiver `/rbac/notify-revoke` (~30 LOC)

```typescript
app.post('/rbac/notify-revoke', async (req, reply) => {
  const signature = req.headers['x-rbac-signature'];
  if (!verifySignature(req.body, signature, RBAC_WEBHOOK_SECRET)) {
    return reply.code(401).send();
  }
  const { user_sub, tenant_id } = req.body;
  await invalidateUserSessions(user_sub);
  cache.delete(cacheKey(user_sub, tenant_id, currentEpoch));
  return reply.send({ ok: true });
});
```

**Rủi ro**: không có webhook → emergency revoke chờ 10s epoch bump → hacker có thêm 10s để phá.

---

## Tổng effort không có SDK

| Item | LOC | Effort | Rủi ro |
|---|---|---|---|
| HTTP client | 30 | 1h | Timeout/retry sai |
| LRU cache + invalidation | 50 | 3h | Stale cache = bypass revoke |
| Epoch poller | 40 | 2h | Cache stampede |
| Circuit breaker | 80 | 4h | Cascade failure khi Central down |
| Fail-close policy | 10 | 30 phút | **Class-A: fail-open = ai cũng admin** |
| Tenant extractor per route | 20 × N | 30 phút × N | Privilege escalation |
| Webhook receiver | 30 | 2h | Emergency revoke chậm 10s |
| Test tất cả | — | 8h | Bug ẩn |
| **Tổng** | **260-500 LOC** | **~1 tuần** | 7 security hole tiềm ẩn |

Cộng **debugging** khi vào prod (cache race, epoch drift, circuit breaker bug) → thêm **1-2 tuần**.

---

## Với SDK

```typescript
// package.json: "@onelog/central-rbac-client": "file:../central-rbac-client"

import Fastify from 'fastify';
import { centralRbacFastify } from '@onelog/central-rbac-client/fastify';

const app = Fastify();

await app.register(centralRbacFastify, {
  centralUrl: process.env.CENTRAL_URL,
  centralRbacToken: process.env.CENTRAL_RBAC_TOKEN,
  appSlug: 'helpdesk',
});

app.get('/tickets',
  { preHandler: app.rbac.requirePermission('helpdesk:tickets.list', { tenantIdFrom: 'query.dept' }) },
  async (req, reply) => { /* business logic */ }
);
```

**~10 LOC. 30 phút setup. Không có 7 rủi ro trên.**

---

## Kết luận

Không có SDK, member phải:

1. **Đọc hiểu Central RBAC contract** (2h): resolve endpoint, epoch endpoint, X-Rbac-Token, tenant scoping semantics
2. **Tự viết 260-500 LOC hạ tầng** (1 tuần): 7 concerns kể trên
3. **Tự test edge case** (8h): Central down, epoch race, cache invalidation, emergency revoke
4. **Debug prod bug** (1-2 tuần): mỗi app tự gặp lại bug SDK đã fix
5. **Duy trì code** khi Central API thay đổi (VD `/v2` → `/v3` sau này) → **N app × N lần update**

**Với SDK**: 30 phút setup, 10 LOC per route, không lo hạ tầng.

**SDK không phải "sang chảnh" — là rào chắn an ninh** ngăn app dev vô tình mở lỗ hổng.

**Rủi ro cao nhất khi không dùng SDK**: fail-open trong prod → 1 lần Central hắt hơi = toàn hệ thống mất kiểm soát quyền → phải audit lại toàn bộ traffic trong downtime.

---

## FAQ

**Q: App tôi không phải Node.js, dùng Python/Go, thì sao?**
A: Chưa có SDK Python (Phase 4b, defer). Tạm thời phải tự viết. Recommend port SDK Node logic sang — reference code + test tại `central-rbac-client/`.

**Q: App tôi rất đơn giản, chỉ 1-2 role, có cần SDK không?**
A: Vẫn nên. 7 concerns trên không scale theo số role — chúng scale theo số app. App đơn giản vẫn cần fail-close, cache invalidation, circuit breaker.

**Q: SDK có bug thì sao?**
A: SDK có test coverage ≥80% + prod smoke test verified 2026-09-14. Bug SDK → fix 1 chỗ, tất cả app hưởng. Bug tự viết → fix N chỗ, dễ miss.

**Q: SDK version compatibility với Central?**
A: SDK v0.1.0+ pin `X-Api-Version: 2` header. Central v2 endpoints giữ ổn định tới 2028-03-10. Breaking change → bump major SDK.

**Q: Per-app token vs shared token?**
A: Từ 2026-09-15 (Central v2.0.1 + SDK 0.2.0), mỗi app có token riêng format
   `rbac_<8prefix>_<24secret>`. Trước đây shared `CENTRAL_RBAC_RESOLVE_TOKEN`
   dùng chung — leak 1 app = compromise tất cả. Per-app: revoke riêng,
   audit rõ app nào gọi, rate limit riêng. SDK config API không đổi
   (`centralRbacToken: string`), chỉ giá trị token thay đổi. Get token từ
   Central Admin UI wizard (khi register) hoặc `/apps/<slug>/tokens` page.

**Q: Legacy shared token còn dùng được không?**
A: Có, tới 2028-01-01 (grace period 3 tháng+). SDK 0.2.0+ log warning khi
   detect. Migrate: tạo per-app token qua UI → update `.env`
   `CENTRAL_RBAC_TOKEN=rbac_...` → deploy → verify `/v2/resolve` pass.

---

## Related

- [App onboarding 5-step](central-rbac-app-onboarding.md) — quickstart implementation
- [v1 vs v2 workflow](central-rbac-v1-vs-v2-workflow.md) — architectural context
- [Manifest v1→v2 migration](central-rbac-manifest-v2-migration.md) — cho app cũ upgrade
- SDK source: `central-rbac-client/`
