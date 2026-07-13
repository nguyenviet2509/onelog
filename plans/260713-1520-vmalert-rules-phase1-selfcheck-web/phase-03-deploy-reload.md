# Phase 03 — Deploy + reload vmalert trên LogServer

**Priority:** Deploy gate
**Effort:** ~15m
**Status:** pending
**Blocked by:** Phase 02 (rules committed + pushed)

## Mục tiêu

Push rules.yml lên LogServer + reload vmalert + verify 7 rules parse OK.

## Steps

Copy-paste block trên LogServer:

```bash
# 1. Pull config mới
cd ~/onelog && git pull

# 1b. DRY-RUN validate trước khi recreate (red-team H1 fix)
# Nếu parse error → không recreate, git revert luôn
docker run --rm -v $(pwd)/infra/vmalert/rules.yml:/rules.yml \
  victoriametrics/vmalert:latest \
  -rule=/rules.yml \
  -notifier.url=http://localhost:9093 \
  -datasource.url=http://localhost:9428/ \
  -dryRun 2>&1 | tail -20
# Expect: rules loaded successfully. Nếu có "cannot parse" → STOP, git revert.

# 2. Reload vmalert (bind mount → chỉ cần restart container)
docker compose -f infra/docker-compose.yml --profile alerts up -d --force-recreate vmalert

# 3. Verify parse OK — không có rule nào ở state "error"
curl -s http://localhost:8880/api/v1/rules | python3 -c "
import json, sys
data = json.load(sys.stdin)
errors = []
new_rules = ['HostLogSilent','VictoriaLogsSelfError','DockerContainerRestartLoop',
             'WebServer4xxFlood','FileDescriptorExhaustion','PhpFpmWorkerExhaustion','LsphpSegfault']
for group in data.get('data', {}).get('groups', []):
    for rule in group.get('rules', []):
        name = rule.get('name','')
        if name in new_rules:
            state = rule.get('state','?')
            last_err = rule.get('lastError','')
            print(f'  {name:35s} state={state:10s} err={last_err[:60]}')
            if state == 'error' or last_err:
                errors.append(name)
print()
print('❌ ERRORS:' if errors else '✅ 7/7 rules parsed OK')
for e in errors: print(f'  - {e}')
"

# 4. Verify vmalert alive + đang eval
docker compose -f infra/docker-compose.yml --profile alerts logs vmalert --tail 30 | grep -E "error|panic|failed" || echo "✅ no errors trong log"

# 5. Verify alerts endpoint đang active
curl -s http://localhost:8880/api/v1/alerts | python3 -m json.tool | head -50
```

## Verify checklist

- [ ] git pull thành công, thấy commit rules mới
- [ ] `docker compose ps vmalert` → status `Up`
- [ ] 7 rules xuất hiện trong `/api/v1/rules` output
- [ ] Không có `state: error` hoặc `lastError` non-empty
- [ ] `docker compose logs vmalert` không có `parse error` / `panic`

## Rollback

Nếu bất kỳ rule nào parse error → **cả file rules.yml sẽ không load** → tất cả rules cũ cũng chết:

```bash
cd ~/onelog
git log --oneline -3
git revert HEAD --no-edit
docker compose -f infra/docker-compose.yml --profile alerts up -d --force-recreate vmalert
# Verify: curl -s http://localhost:8880/api/v1/rules | grep -c '"name"'  → phải match rule count cũ
```

## Rủi ro

- **1 rule sai syntax → toàn bộ group không load** → mất luôn rules đang chạy cùng group. Mitigation: sanity check YAML local trước push (Phase 02 checklist).
- **Service label sai** (Phase 01 miss) → rule state=inactive vĩnh viễn. Không phải parse error, không rollback tự động — sẽ phát hiện ở Phase 04 khi trigger test.

## Success

- 7 rules listed trong `/api/v1/rules`, không error state
- vmalert container up + eval bình thường
- Alertmanager `/api/v2/alerts` accessible (chuẩn bị cho Phase 04)

## Next phase

→ [phase-04-manual-trigger-tests.md](phase-04-manual-trigger-tests.md)
