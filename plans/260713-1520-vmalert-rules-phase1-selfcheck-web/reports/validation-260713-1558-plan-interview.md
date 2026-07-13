# Validation — vmalert rules phase1 plan interview

**Date:** 2026-07-13 15:58
**Purpose:** confirm decisions còn ambiguous sau red-team review

---

## Confirmed decisions

### V1. Auditd verify — conditional edit in Phase 06
**Decision:** Verify `service:auditd` trong Phase 01. Nếu miss → drop AuditLoginFailures edit khỏi Phase 06, ghi P2 backlog "extend Vector scrape auditd".

**Impact:** Phase 06 có thể fix 3 rules (SshBrute, MysqlBurst, WebServerErrorBurst) thay vì 4. Không ship dead rule.

**Applied:** phase-06 doc đã cập nhật conditional block.

---

### V2. Fake-log inject test acceptable
**Decision:** OK inject fake logs vào VL với `host:testinject` prefix. VL retention 30d → auto-cleanup.

**Impact:** Không cần thêm delete-after-test step. Query normal ops có thể `-host:testinject` để filter.

**Applied:** phase-04 đã có `host:testinject` trong tất cả inject payload.

---

### V3. LsphpSegfault severity=critical intentional
**Decision:** 1 segfault = bug nghiêm trọng đáng nhắc mỗi 30m qua Telegram critical thread. Không hạ warning.

**Impact:** Alertmanager route `severity=critical` (30m repeat_interval) sẽ apply. Ops có thể ack + silence manually nếu debug xong.

**Applied:** phase-02 giữ severity=critical + threshold >0 + for=30s.

---

### V4. P2 backlog → plan riêng
**Decision:** 3-4 items (HostLogSilent, DockerRestart, WebServer4xxFlood, có thể AuditLoginFailures nếu V1 miss) sẽ tách sang **plan mới** khi Phase 1 xong. Không mix P2 với P1.

**Impact:** Phase 1 close-out cần trigger tạo plan P2. Có thể name: `plans/260Xxx-vector-source-extension-p2/`.

**Applied:** plan.md Success criteria section đã note "tách sang plan mới".

---

## Remaining unresolved questions

1. **VL delete endpoint** — nếu muốn cleanup fake logs sớm hơn 30d retention, LogsQL có `DELETE`? Chưa verify. Not blocking Phase 1.
2. **Docker log rotation impact** — plan `260710-1432-logserver-rotation-a-plus-e` đang pending. Có thể ảnh hưởng Docker daemon log format → khi implement P2 DockerRestartLoop cần check.
3. **auditd log format khi có** — `res=failed` là format auditd binary/text? Có thể khác. Verify trong Phase 01 nếu label tồn tại.

---

## Ship readiness verdict

**READY.** Tất cả C1/C2/H1-H5 (red-team) đã fix hoặc defer P2. Validation confirmed conditional handling cho auditd + intentional severity choice cho segfault.

**Cook command:**
```
/ck:cook plans/260713-1520-vmalert-rules-phase1-selfcheck-web/plan.md
```
