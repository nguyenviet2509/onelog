# Red-Team Review — vmalert rules phase1 plan

**Date:** 2026-07-13 15:44
**Target:** `plans/260713-1520-vmalert-rules-phase1-selfcheck-web/`
**Reviewer stance:** hostile / adversarial — find blind spots, false assumptions, silent failures

---

## 🔴 CRITICAL — must fix before ship

### C1. HostLogSilent — RULE CANNOT FIRE AS DESIGNED

**Expr hiện tại:**
```logsql
* _time:15m | stats by (host) count() as value | filter value:<1
```

**Bug:** `stats by (host) count()` chỉ emit rows cho hosts CÓ ≥1 log. Host silent = 0 log = **không xuất hiện trong output** → `filter value:<1` không bao giờ match.

Đây là LogsQL semantics tương tự SQL: `GROUP BY` không tự tạo row cho group thiếu data. `absent()` như Prometheus không tồn tại trong LogsQL.

**Chứng minh:** Chạy test trên VMUI với 1 host stopped:
```
* _time:15m | stats by (host) count()
```
→ output chỉ hiện hosts đang hoạt động. Silent host vắng mặt.

**Fix options:**

1. **Recording rule pair** — snapshot host list mỗi 5m, compare hiện tại vs snapshot. Phức tạp.
2. **Vector heartbeat metric via vmagent** — Vector emit `up{host=X}` mỗi 1m qua Prometheus endpoint. vmalert dùng metric rule (`type: prometheus`), không phải vlogs:
   ```yaml
   - alert: HostLogSilent
     expr: absent(up{host="srv-01"}) or (time() - vector_last_log_timestamp{host="srv-01"} > 900)
   ```
   Cần vmagent scrape Vector metrics — check config hiện tại.
3. **Hardcode expected host list** trong rule (bẩn, fragile):
   ```logsql
   * host:(srv-01 OR srv-02 OR logserver) _time:15m
     | stats by (host) count() as v
     | filter v:<1
   ```
   Vẫn không work vì lý do trên. Bỏ.
4. **External check** — cron script trên logserver query VL cho từng expected host, POST alert nếu 0.

**Recommend:** Option 2 (heartbeat metric). Nếu Vector chưa expose metrics → drop R1 khỏi Phase 1a, ghi P2 backlog.

**Impact:** R1 là rule QUAN TRỌNG NHẤT của plan (silent-failure detection lõi). Bug này khiến 1/6 rules Phase 1a chết.

---

### C2. Docker events có trong VL không?

Phase 01 có step verify `service:docker` nhưng plan không có contingency rõ ràng nếu miss:
- Docker daemon log qua journald default → cần Vector scrape journal với filter service=docker
- Nếu Vector chỉ scrape file `/var/log/*.log` → miss Docker daemon events hoàn toàn

Grep infra/vector/ để confirm source. Nếu không có → R3 dead ngay, không phải "phát hiện Phase 04". Đưa verify LÊN TRƯỚC Phase 02, không phải sau.

---

## 🟠 HIGH — nên fix

### H1. Không có dry-run validation step

Plan Phase 03 rollback = `git revert + docker recreate`. Nhưng nếu 1 rule sai syntax → cả file fail load → **mất luôn 27 rules cũ** trong 5-10m rollback window. Trong window đó có incident thật → mù.

**vmalert hỗ trợ dry-run:**
```bash
docker run --rm -v $(pwd)/infra/vmalert/rules.yml:/rules.yml victoriametrics/vmalert \
  -rule=/rules.yml -dryRun
```

Thêm vào Phase 02 (local check) + Phase 03 (before force-recreate).

### H2. LsphpSegfault severity + threshold sai

Hiện: `severity: warning`, `filter value:>2`.

Segfault = **bug PHP extension / OPcache corrupt / memory violation**. 1 segfault là đủ signal. Threshold >2/1m = phải 3 crash mới fire → mất time để catch.

**Đề xuất:** `severity: critical`, `filter value:>0`, `for: 30s`. Nếu prod thấy nhiều false positive từ 1 script buggy → tune LÊN sau, không phải ngược lại.

### H3. Test DockerRestart trigger sai policy

Phase 04:
```bash
docker run -d --name test-restart-loop --restart=on-failure alpine sh -c 'sleep 5; exit 1'
```

Docker `--restart=on-failure` default cap 5 retries. Với threshold >10, container die 5 lần → alert không fire → test đánh giá sai là "rule broken".

**Fix:** dùng `--restart=on-failure:20` hoặc `--restart=always`.

### H4. Verification blind spots — 4/6 rules không có trigger test

Phase 04 chỉ test 2/6 rules (HostLogSilent, DockerRestart). VLSelfError, FDExhaustion, PhpFpmExhaust, LsphpSegfault chỉ "verify passive" = nếu 24h không fire thì "assume work". **Vô nghĩa** — không fire có thể vì rule broken, không có event thật, hoặc label sai.

**Fix:** inject fake log qua Vector HTTP sink hoặc direct VL insert:
```bash
# Test FDExhaustion
curl -H 'Content-Type: application/json' -d '[{"host":"testhost","service":"testfd","_msg":"Too many open files","severity":"err"}]' \
  http://localhost:9428/insert/jsonline

# Chờ 2m → verify alert fire
```
Add 1 test cho mỗi rule → detect bug sớm.

### H5. Phase ordering — Phase 06 blocked bởi Phase 05 SAI

Plan có `Blocked by: Phase 05 (baseline observation)` nhưng note "có thể chạy song song".

**Reality:** 4 mock rules đang **DEAD**. Prod ramp-up không có coverage MySQL/SSH/Audit/Web err. Đây là gap nghiêm trọng HƠN 6 rules Phase 1a mới. Nên **UP-PRIORITIZE Phase 06 lên đầu**, thậm chí trước Phase 02.

Order đề xuất:
```
01 verify → 06 fix mock (parallel-safe) → 02 add new → 03 deploy → 04 test → 05 observe
```

---

## 🟡 MEDIUM — cân nhắc

### M1. `_msg:"max_children"` matcher quá generic (PhpFpmExhaust)

Có thể match:
- PHP docs được log ra debug
- Config file content được logrotate/backup script cat vào syslog
- Grep output trong operational script

**Fix:** dùng exact php-fpm format:
```
_msg:"server reached pm.max_children" OR _msg:"[NOTICE]" _msg:"max_children"
```

### M2. VictoriaLogsSelfError — circular dependency

Nếu VL sập → Vector không ship được → VL logs không vào VL → rule không có data → không fire. Chicken-egg đã note nhưng plan không giải quyết. Đây là lý do khác cần DMS external. User đã accept skip DMS — OK nhưng nên document plan này KHÔNG catch VL total outage.

### M3. Rename `NginxServerErrors → WebServerErrorBurst`

Phase 06 rename. Impacts:
- ✅ Silence hiện tại — check via `amtool silence query`
- ❓ Grafana/dashboard reference alertname — chưa check
- ❓ Historical alert notification tracking (Telegram thread search)
- ❓ Downstream automation (nếu có runbook auto-trigger theo alertname)

**Fix:** Grep `NginxServerErrors` toàn repo trước rename:
```bash
grep -r "NginxServerErrors" d:/Vietnt/Project/onelog --include="*.md" --include="*.yml" --include="*.html"
```

### M4. Success criteria không đo được

"Không false positive trong 24h đầu" — làm sao đo? Cần metric:
- Count alerts fired / rule / 24h
- Ops manual mark mỗi fire = true/false positive
- False positive rate % < 20% mới pass

Không có tool tự động. Đề xuất: mở Telegram history 24h sau, review từng alert 1 lần.

### M5. Threshold conservative >10 cho VLSelfError có thể quá cao

VL bình thường: 0 err/day. Nếu VL đang có low-severity issue (disk gần đầy, ingest lag) — có thể emit 5-10 err/day mà không fire. Rule bỏ qua signal quan trọng.

**Cân nhắc:** giữ >5 nhưng chấp nhận false positive ban đầu. VL err không dồn dập như log app.

---

## 🟢 LOW — nitpicks / future

### L1. Group `log-pipeline-selfcheck` name conflict với `disk-alerts` semantic

`disk-alerts` cũng có DiskProbeStale — arguably là "pipeline selfcheck". Không có gộp naming convention. Cosmetic.

### L2. Không có runbook link (đã note backlog)

### L3. Không có Alertmanager route riêng cho `component:log-pipeline`

Rule mới severity=warning sẽ dùng default route (2h repeat_interval). OK cho warning nhưng critical rule như VLSelfError sẽ dùng route `severity=critical` (30m) — chưa test integration.

---

## Verdict

**Ship blocker:** C1 (HostLogSilent bug), C2 (verify Docker source).

**Ship-with-fix:** H1 (dry-run), H2 (LsphpSegfault severity), H3 (test policy), H4 (inject test cho 4 rules), H5 (reorder phases).

**Nice-to-have:** M1-M5.

## Recommendations

### Update plan trước khi cook

1. **C1 fix HostLogSilent:** 3 options — Option 2 (metric-based) cần verify Vector metrics endpoint. Nếu không có → drop khỏi Phase 1a, ghi P2 backlog. **Không ship rule dead.**
2. **C2 verify Docker Vector source TRƯỚC Phase 02** — không phải sau. Move check vào Phase 01.
3. **H1 add dry-run** vào Phase 02 checklist + Phase 03 pre-recreate.
4. **H2 change LsphpSegfault** → severity=critical, filter value:>0, for:30s.
5. **H3 fix test container** → `--restart=always`.
6. **H4 add fake-log inject test** cho 4 rules còn lại.
7. **H5 reorder** — Phase 06 sau Phase 01, trước Phase 02. Rename tiêu đề Phase 06 = Phase 1a-B nếu muốn giữ semantic 1a.

### Cân nhắc scope

Bây giờ plan thực tế bao gồm:
- 5-6 rules mới (bỏ HostLogSilent nếu Option 2 không khả thi)
- Fix 4 mock rules
- 6 phases workflow

Vẫn KISS-compliant. Không over-scope.

---

## Unresolved questions

1. Vector có expose Prometheus metrics endpoint (heartbeat / uptime) không? Nếu có → HostLogSilent metric-based khả thi. Nếu không → phải drop.
2. Vector đang scrape Docker daemon events (journald filter service=docker) không?
3. `service:auditd` có tồn tại trong VL không? Phase 06 giả định có nhưng chưa verify.
4. Bao giờ prod ramp-up? Nếu >2 tuần nữa → có thể defer thêm rules.
5. Có dashboard/automation nào reference `NginxServerErrors` alertname không (cần grep toàn repo)?
