# Phase 06 — Extend 4 mock-only rules → real service matcher

**Priority:** Prod-readiness gap
**Effort:** ~20m
**Status:** pending
**Blocked by:** Phase 01 (verify service:auditd label)
**Reorder (red-team H5):** Phase 06 chạy TRƯỚC Phase 02. Rationale: 4 mock rules DEAD trong prod là gap nghiêm trọng hơn adding new rules. Không đợi Phase 05.

## Bối cảnh

4 rules hiện tại matcher `service:mock-*` → **chỉ fire trên test fixtures**, không catch log thật từ prod services. False sense of security: ops nghĩ có coverage MySQL/SSH/Audit/Nginx nhưng thực tế mù.

## Files to modify

- `infra/vmalert/rules.yml` — extend matcher 4 rules

## Real service labels

Confirmed từ user (query manual verify trước ship):
- MySQL: `service:mysqld`
- SSH: `service:sshd`
- OpenLitespeed (thay nginx): `service:litespeed`
- Audit: **cần verify** — dự đoán `service:auditd`

## Edits

### 1. SshBruteForce ([rules.yml:78-86](../../infra/vmalert/rules.yml#L78))

```yaml
# BEFORE
expr: 'service:mock-sshd "Failed password" | stats by (host, host_ip) count() as value, row_any(_msg) as sample_msg | filter value:>20'

# AFTER
expr: '(service:sshd OR service:mock-sshd OR service:ssh) "Failed password" | stats by (host, host_ip) count() as value, row_any(_msg) as sample_msg | filter value:>20'
```

### 2. MysqlErrorBurst ([rules.yml:88-96](../../infra/vmalert/rules.yml#L88))

```yaml
# BEFORE
expr: 'service:mock-mysql severity:err | stats by (host, host_ip) count() as value, row_any(_msg) as sample_msg | filter value:>30'

# AFTER
expr: '(service:mysqld OR service:mysql OR service:mock-mysql) severity:err | stats by (host, host_ip) count() as value, row_any(_msg) as sample_msg | filter value:>30'
```

### 3. AuditLoginFailures ([rules.yml:98-106](../../infra/vmalert/rules.yml#L98))

**Validation 2026-07-13:** nếu Phase 01 verify `service:auditd` KHÔNG tồn tại trong VL → **DROP edit này**, giữ nguyên rule cũ chỉ match mock. Ghi backlog "Extend Vector scrape auditd" trong P2.

Nếu confirmed:
```yaml
# BEFORE
expr: 'service:mock-audit "res=failed" | stats by (host, host_ip) count() as value, row_any(_msg) as sample_msg | filter value:>10'

# AFTER
expr: '(service:auditd OR service:mock-audit) "res=failed" | stats by (host, host_ip) count() as value, row_any(_msg) as sample_msg | filter value:>10'
```

### 4. NginxServerErrors ([rules.yml:108-116](../../infra/vmalert/rules.yml#L108))

Rename → `WebServerErrorBurst` (vì prod dùng OLS, không phải nginx):

```yaml
# BEFORE
- alert: NginxServerErrors
  expr: 'service:mock-nginx severity:err | stats by (host, host_ip) count() as value, row_any(_msg) as sample_msg | filter value:>100'
  annotations:
    summary: "Nginx 5xx burst on {{ $labels.host }}"

# AFTER
- alert: WebServerErrorBurst
  expr: '(service:litespeed OR service:mock-nginx OR service:nginx) severity:err | stats by (host, host_ip) count() as value, row_any(_msg) as sample_msg | filter value:>100'
  annotations:
    summary: "Web server 5xx burst on {{ $labels.host }}"
    description: "{{ $value }} web err events in last 5m on {{ $labels.host }} — check OLS/nginx error log"
```

## Verify trước khi commit

```bash
# Trên LogServer — confirm real services đang emit vào VL
curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=service:mysqld | limit 3' --data-urlencode 'start=6h'
curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=service:sshd | limit 3' --data-urlencode 'start=6h'
curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=service:litespeed | limit 3' --data-urlencode 'start=6h'
curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=service:auditd | limit 3' --data-urlencode 'start=6h'
```

Nếu label real KHÔNG tồn tại → 2 khả năng:
1. Vector chưa scrape source đó → cần extend Vector config (out of scope, ghi backlog)
2. Label khác → điều chỉnh matcher

## Todo

- [ ] Verify 4 real service labels tồn tại trong VL
- [ ] Edit 4 expr (SshBrute, MysqlBurst, AuditLogin, NginxErr → WebServerErrorBurst)
- [ ] Rename NginxServerErrors → WebServerErrorBurst (cả alert name + annotation)
- [ ] YAML lint
- [ ] Commit: `fix(vmalert): extend mock-only matchers to include real prod services`

## Rủi ro

- **Threshold cũ dùng cho mock volume có thể sai cho prod** — ví dụ MysqlErrorBurst >30/5m tune cho mock-mysql emit rate. Prod MySQL im lặng bình thường → threshold có thể quá cao. **Mitigation:** giữ threshold, observe 1 tuần, tune ở Phase 05 iteration 2.
- **Rename alert `NginxServerErrors → WebServerErrorBurst`** — grep repo confirmed chỉ xuất hiện ở `rules.yml` + `mockups/onelog-services-detail.html`. Sync mockups sau rename. Không có silence / Grafana dashboard / automation reference. → An toàn rename.
- **Audit label chưa confirmed** — nếu `service:auditd` không có, rule vẫn fire cho mock. Ghi backlog verify.

## Success

- 4 rules parse OK sau reload vmalert
- Query manual: `service:mysqld severity:err` có kết quả (proof matcher work)
- Prod MySQL/SSH/Audit incident sẽ fire alert (không còn dead rule)

## Deferred to Phase 2

- Add REAL new rules cho OLS access log 4xx/5xx (đã defer trong Phase 1b)
- Threshold tune sau baseline 2 tuần
- Vector source coverage audit (đảm bảo sshd/mysqld/auditd/litespeed đều được scrape)
