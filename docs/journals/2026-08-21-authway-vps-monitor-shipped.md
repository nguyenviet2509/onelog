# 2026-08-21 — Authway-vps monitor integration shipped

Plan [260821-1013-authway-vps-monitor-integration](../../plans/260821-1013-authway-vps-monitor-integration/plan.md) 4 phase xong end-to-end trong ~2h (est 3-3.5h). Fast-mode cook không stop giữa phase, apply trực tiếp lên 2 prod VPS (authway-vps + onelog-vps) qua SSH.

## Kết quả

- **Scrape 7 target UP**: 3 exporter (node/cadvisor/zitadel) + 3 blackbox HTTP probe + 1 TCP LDAP probe. `count(up{cluster="authway"}==1) = 7`.
- **Vector agent** forward log 4 container authway-vps → VL onelog-vps `host=authway`. Verified query `host:"authway" | stats by (service)` show postgres/zitadel/traefik.
- **Grafana dashboard "Authway Overview"** provisioned qua bind-mount (UID `authway-overview`, 12 panels).
- **8 vmalert rules** (3 critical + 5 warning) trong 2 group `authway-{critical,warning}` load OK trong `vmalert-metrics`.
- **Alertmanager route** `cluster="authway"` → receiver `telegram-trend` (topic 880). Đặt TRƯỚC `severity=critical` / `notify_style=event` để tránh hijack.
- **End-to-end firing test** verified: `docker compose stop zitadel` → `AuthwayZitadelDown` state=firing → receiver=telegram-trend trong ~90s. Restart → auto-resolve.

## 2 commit

- OneLog `06bf492` feat(observability): authway-vps monitor integration
- Authway `59dd61d` feat(authway-vps): expose metrics + deploy observability sidecars

## Gotchas + learning

1. **Phase 0 giả định sai** — plan viết "OneLog Vector hardcode `.host = 'logserver'` cho tất cả docker_logs source". Thực tế Vector config chỉ tag `host=logserver` cho 3 pipeline riêng (`tag_litellm_cost`, `openwebui_db_parse`, `logserver_disk_parse`). Docker_logs source chung chỉ có 1 container (`ragstack-litellm`), phần còn lại đi syslog input. Vì vậy VMUI `host:"logserver"` return 3 service — không phải "gap", cũng không phải "convention nhất quán". Doc `observability-log-forwarding-convention.md` viết reality, không copy plan.

2. **VictoriaLogs bind 127.0.0.1 → mù cross-VPS ingest** — VL container port `9428` bind `127.0.0.1` only trên onelog-vps. Vector agent authway-vps push tới `10.200.0.30:9428` → connection refused. Fix: thêm binding thứ 2 `10.200.0.30:9428:9428`. Learning: khi thiết kế cross-VPS observability, cần chốt sớm private-IP binding chứ không mặc định 127.0.0.1. Analogous với chuyện `docker-proxy` từng gặp trên Grafana port trước đây.

3. **Compose profile hỗn hợp** — service `vmalert-metrics` được cấu hình `profiles: [alerts, monitoring]` nhưng `depends_on: alertmanager` (profile `[alerts]` only). Chạy `docker compose --profile monitoring up ...` fail: `service "vmalert-metrics" depends on undefined service "alertmanager"`. Phải kích hoạt cả 2 profile. Learning: khi profile split gộp, kiểm depends_on cross-profile trước khi expose command chuẩn.

4. **VRL `merge() ?? .` unnecessary error coalescing** — Vector 0.42 VRL parser reject pattern `. = merge(., object!(parsed)) ?? .` với `error[E651]: this expression can't fail`. `object!()` đã panic nếu không phải object → merge không thể fail. Fix: bỏ `?? .`. Learning: nếu inner expression đã dùng `!` (assert!), outer coalescing = dead code.

5. **`_msg` field required by VL** — VL warn `missing _msg field` khi Vector không set. Docker_logs source dùng `.message` nhưng VL expect `._msg`. Fix: set `._msg = raw_msg` trong remap trước khi `del(.message)`. Learning: mọi remap pipeline mới phải set `_msg` explicit — không có `_msg` VL vẫn nhận nhưng query sẽ nhầm.

## Điểm hay của pattern (validated)

- **Reuse receiver `telegram-trend`** thay tạo receiver mới cho topic 880 — 0 env var mới, 0 template change. Chỉ cần 1 route matcher đặt đúng thứ tự.
- **Bind mount + Grafana provisioning `updateIntervalSeconds: 30`** — copy file JSON vào `infra/grafana/dashboards/` → dashboard tự lên UI trong < 1 phút. Không cần API call.
- **Alert `absent(up{...})` guard** — chống miss alert khi scrape fail (target disappear thay vì `up=0`).

## Follow-up (không blocker)

- Backup schedule Postgres authway-vps chưa có cron chính thức. TODO trong runbook.
- LDAP monitor sâu hơn (bind test thật, không chỉ TCP probe) → khi cần.
- Consider secondary email channel cho critical severity (Telegram có thể miss nếu bot revoke).
- Verify Telegram topic 880 thực sự nhận message (không rẽ ra topic khác) — cần anh confirm trong session sau.
