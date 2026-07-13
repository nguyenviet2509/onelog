# Phase 04 — Fake-log inject tests (all 4 rules Phase 1a)

**Priority:** Validation gate
**Effort:** ~30m
**Status:** pending
**Blocked by:** Phase 03 (vmalert alive với 4 rules Phase 1a)

## Red-team update H4

Trước: chỉ trigger 2/6 rules (HostSilent, DockerRestart). Cả 2 giờ đã drop khỏi Phase 1a. **Approach mới: inject fake log qua VL HTTP API → verify từng rule fire end-to-end.**

## Mục tiêu

Inject fake log matching mỗi rule matcher → wait 2-10m → verify Telegram nhận alert → cleanup silence.

## Setup: silence tất cả 4 alerts trước khi test (tránh spam ops)

```bash
amtool silence add alertname=~"VictoriaLogsSelfError|FileDescriptorExhaustion|PhpFpmWorkerExhaustion|LsphpSegfault" \
  --duration=2h --comment="phase-04 fake-log inject test"
```

## Common — VL inject endpoint

VictoriaLogs accepts JSON POST tại `/insert/jsonline`. Format: 1 JSON per line, gồm `_msg`, `_time` optional, các fields tự do trở thành labels.

## Test 1: VictoriaLogsSelfError (threshold >10/2m)

Inject 12 err lines để vượt threshold:

```bash
for i in $(seq 1 12); do
  echo "{\"_msg\":\"[error] fake VL error line $i for test\",\"service\":\"victorialogs\",\"severity\":\"err\",\"host\":\"testinject\"}"
done | curl -X POST -H 'Content-Type: application/stream+json' --data-binary @- \
  'http://localhost:9428/insert/jsonline?_stream_fields=service,host'

# Wait 3-5m
sleep 300
curl -s http://localhost:9093/api/v2/alerts | grep -A2 VictoriaLogsSelfError
```

**Expected:** alert fire trong 3-5m (2m eval window + for=2m + evaluation tick lag).

## Test 2: FileDescriptorExhaustion (threshold >3/1m)

```bash
for i in $(seq 1 5); do
  echo "{\"_msg\":\"Too many open files (fake test $i)\",\"service\":\"testfd\",\"host\":\"testinject\"}"
done | curl -X POST -H 'Content-Type: application/stream+json' --data-binary @- \
  'http://localhost:9428/insert/jsonline?_stream_fields=service,host'

sleep 180
curl -s http://localhost:9093/api/v2/alerts | grep -A2 FileDescriptorExhaustion
```

**Expected:** fire trong ~2m.

## Test 3: PhpFpmWorkerExhaustion (threshold >0)

```bash
echo '{"_msg":"[NOTICE] server reached pm.max_children setting (5), consider raising it","service":"php-fpm","host":"testinject"}' \
  | curl -X POST -H 'Content-Type: application/stream+json' --data-binary @- \
    'http://localhost:9428/insert/jsonline?_stream_fields=service,host'

sleep 120
curl -s http://localhost:9093/api/v2/alerts | grep -A2 PhpFpmWorkerExhaustion
```

**Expected:** fire trong ~1-2m.

## Test 4: LsphpSegfault (threshold >0, severity=critical)

```bash
echo '{"_msg":"lsphp[12345]: segfault at 0x0 rip 0x00007f8c ip 0x00007f8c sp","service":"lsphp","host":"testinject"}' \
  | curl -X POST -H 'Content-Type: application/stream+json' --data-binary @- \
    'http://localhost:9428/insert/jsonline?_stream_fields=service,host'

sleep 90
curl -s http://localhost:9093/api/v2/alerts | grep -A2 LsphpSegfault
```

**Expected:** fire trong ~1m, severity=critical → route qua telegram-trend với repeat 30m.

## Cleanup

```bash
# Remove silence (nếu muốn observe real fire sau này)
amtool silence expire $(amtool silence query -o simple | grep test-inject | awk '{print $1}')
```

Fake log giữ trong VL 30d (retention default) — có thể ignore, hoặc thêm field `test:true` để filter khi query khác.

## Todo

- [ ] Setup silence 2h cho 4 alertnames
- [ ] Test 1: VictoriaLogsSelfError
- [ ] Test 2: FileDescriptorExhaustion
- [ ] Test 3: PhpFpmWorkerExhaustion
- [ ] Test 4: LsphpSegfault (verify severity=critical route đúng, repeat_interval=30m)
- [ ] Ghi kết quả vào bảng dưới
- [ ] Cleanup silence sau khi observe xong

## Results table

| Rule | Fire? | Latency | Notes |
|---|---|---|---|
| VictoriaLogsSelfError | | | |
| FileDescriptorExhaustion | | | |
| PhpFpmWorkerExhaustion | | | |
| LsphpSegfault | | | |

## Rủi ro

- Fake logs pollute VL search UI — test bằng `host:testinject` prefix để filter dễ.
- Nếu VL không expose `/insert/jsonline` public (chỉ internal) → cần chạy inject từ trong container network hoặc port-forward.
- Nếu quên silence → 4 alerts fire lên Telegram thật, spam ops.

## Success

- 4/4 fire trong window expected
- LsphpSegfault route đúng severity=critical → repeat 30m (verify qua alertmanager route logs)
- Không có rule nào chờ >10m mới fire (dấu hiệu threshold/for sai)

## Next phase

→ [phase-05-observation-tune.md](phase-05-observation-tune.md)
