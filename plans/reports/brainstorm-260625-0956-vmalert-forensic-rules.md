# Brainstorm: vmalert forensic rules tận dụng schema mới

**Date:** 2026-06-25 09:56 (+07)
**Branch:** master
**Status:** Design — pending plan / cook
**Owner:** vietnt

---

## 1. Problem Statement

Sau khi unified schema rsyslog (UDP/TCP + JSON 6515) thêm `facility` + `host_ip`,
các rule vmalert hiện tại (4 rule: sshd brute / mysql err / audit fail / nginx 5xx)
chưa khai thác hết. 3 lớp insight ops cần mà rule cũ KHÔNG cung cấp:

1. **Cross-host correlation by source IP** — 1 IP tấn công nhiều host.
2. **Facility-based classification** — phân loại kern/auth/cron sự cố.
3. **Audit trail** — sudo escalation, privilege change.

Brutal-honest scope: chỉ focus rule **schema-driven** (cần `facility` hoặc
`host_ip`). Rule generic (err burst per-service) đã có dạng tương tự.

## 2. Selected Rules (MVP 3)

### Rule 1: `SshFailMultiHostSameIp`
- **Why:** 1 source IP probe ≥3 host = coordinated brute force, rule per-host cũ miss.
- **LogsQL:** `facility:auth _msg:"Failed password" | stats by (host_ip) count() as value | filter value:>30`
- **Window:** 15m
- **Labels:** severity=critical, category=security
- **Annotations:** "Brute force from {{ $labels.host_ip }} — {{ $value }} fails across cluster in 15m"

### Rule 2: `KernelErrorBurst`
- **Why:** kernel-level err = hardware/driver fail, đặc biệt khi facility cũ bị
  drop hoàn toàn → giờ truy được. Catch sớm = đỡ data loss.
- **LogsQL:** `facility:kern severity:err | stats by (host) count() as value | filter value:>5`
- **Window:** 5m
- **Labels:** severity=critical, category=system
- **Annotations:** "Kernel errors on {{ $labels.host }} — {{ $value }} events in 5m"

### Rule 3: `SudoEscalation`
- **Why:** sudo audit basic — bất thường về tần suất cần investigate (insider threat
  hoặc compromised account).
- **LogsQL:** `facility:auth _msg:"sudo:" _msg:"COMMAND=" | stats by (host) count() as value | filter value:>20`
- **Window:** 15m
- **Labels:** severity=warning, category=audit
- **Annotations:** "Elevated sudo activity on {{ $labels.host }} — {{ $value }} commands in 15m"

## 3. Implementation

### Files to modify
- `infra/vmalert/rules.yml` — append 3 alert blocks to existing `log-alerts` group
- (Optional) `infra/alertmanager/alertmanager.yml` — route `category=audit` /
  `category=system` nếu khác từ `security` hiện hành; có thể bỏ qua nếu route
  catch-all đang dùng

### Reload
```bash
docker compose -f infra/docker-compose.yml --profile alerts up -d vmalert
docker logs ragstack-vmalert --tail 30
```
vmalert hot-reloads rules.yml mỗi 1m hoặc bằng SIGHUP.

### Threshold tuning protocol
Threshold trong design là educated guess. Sau cook:
1. Tắt firing initial (`for: 30m` thay vì `1m`) để observe baseline.
2. Query LogsQL lịch sử 7d để xác định p95 của count → set threshold = 2×p95.
3. Bật `for: 1m` lại khi threshold tune xong.

## 4. Risks

| Risk | Mitigation |
|---|---|
| Threshold sai → noise hoặc miss | Tune sau 1 tuần observe baseline |
| Rule MISS log cũ (pre-schema-unify) | Forward-only chấp nhận; document trong runbook |
| `_msg:"sudo:" _msg:"COMMAND="` chuỗi tìm có thể miss khi syslog format khác | Test với sample data trước khi prod-fire |
| Alertmanager route mới (category=audit/system) có thể chưa cấu hình | Reuse category=security route nếu chưa muốn split |

## 5. Out of scope (deferred)

- **Rule 4 `HostStoppedReporting`** — LogsQL không có absent(). Workaround
  cần baseline list host. Đẩy sang Prometheus `up{}` metric (đã có infra
  Prometheus team-managed per plan observability-integration).
- **Rule 5 `CronJobFailures`** — value TB, đẩy backlog.
- **Rule 6 `PiiLeakageSignal`** — nice-to-have, giá trị forensic thấp vì redact
  đã work; chuyển thành dev-feedback channel sau (không phải ops alert).

## 6. Success criteria

- 3 rule append vào rules.yml, vmalert reload không lỗi.
- Manual probe (logger fake event với `facility:auth "Failed password"` × 35
  events từ cùng IP) → rule 1 fire trong 15m+1m for.
- Alertmanager forward đến webhook (kiểm tra logs alertmanager).

## 7. Unresolved questions

- Alertmanager hiện route theo `category=security|database|app` (theo rules cũ).
  Category mới `system`/`audit` cần thêm route hay reuse default? Cần audit
  `infra/alertmanager/alertmanager.yml`.
- vmalert profile `alerts` đang opt-in (`profiles: [alerts]`). Production lab
  hiện có chạy không, hay phải bật?
- Baseline data sẵn có để tune threshold không? Hay phải chạy soak 1 tuần?
