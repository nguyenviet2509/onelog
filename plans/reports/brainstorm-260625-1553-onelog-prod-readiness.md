# Brainstorm — OneLog Production Readiness Assessment

**Date:** 2026-06-25 15:53 (Asia/Saigon)
**Owner:** trihd@inet.vn
**Branch:** master
**Context:** Đánh giá readiness deploy OneLog stack lên 1 logserver prod (spec = lab), client = mail server + shared hosting thật (Postfix/Dovecot/cPanel-like), rsyslog có sẵn. Eventual scale 50-200 srv / 100-500 GB/ngày, pilot 1-3 srv trước. Mạng LAN nội bộ + OpenVPN. Team < 5 sysadmin, accept risk nội bộ. Owner sẽ ops giai đoạn đầu, bàn giao 2-3 người sau.

---

## 1. Verdict

- **GO có điều kiện** cho pilot 1-3 srv sau khi fix 5 must-fix mục §3.
- **KHÔNG GO** cho scale-out 50-200 srv ngay — single-node spec lab không chịu nổi 100-500 GB/ngày, cần benchmark thực + plan HA per `docs/ha-roadmap.md` §1.

---

## 2. Trạng thái stack hiện tại (cơ sở đánh giá)

- Stack MCP-only (web/agent decommissioned 2026-06-24), 10 service compose: vector, victorialogs, qdrant, postgres, redis, nats, indexer, mcp-vl, mcp-semantic, caddy.
- Ingest 3 path: UDP 514, TCP 6514 RFC5424, TCP 6515 JSON ECS-lite (mới ship 2026-06-25).
- Setup script idempotent + systemd unit + snapshot daily local + healthcheck script.
- Smoke test lab 3-VM pass, journal verified.
- Auth: Caddy IP whitelist subnet + MCP bearer token (forward_auth qua mcp-semantic).
- Backup: local `/opt/onelog/backup/onelog-*.tar.gz` daily, **không offsite**.
- Monitoring: **chưa có** Prometheus/Grafana, chỉ có `healthcheck.sh` chạy on-demand.
- Retention VictoriaLogs: **default = forever**.
- Mock-logs service: enabled trên lab (bơm fake log để demo).

---

## 3. MUST-FIX trước go-live pilot (P0)

| # | Gap | Risk | Action | Effort |
|---|---|---|---|---|
| 1 | Backup offsite = 0 | Logserver chết = mất toàn bộ data + audit + Drain3 state | Push snapshot lên NAS/MinIO/S3 nội bộ qua rsync/rclone cron. Test 1 lần restore drill | 0.5d |
| 2 | Monitoring = 0 | Vector/Indexer/VL chết im lặng → detection trễ giờ-ngày | Tối thiểu: cron `healthcheck.sh` 5 phút/lần → Telegram alert khi fail. Tốt hơn: VictoriaMetrics + Grafana scrape `/metrics` của vector/indexer/vl + node-exporter | 0.5-2d |
| 3 | PII redaction chưa cover mail/hosting format | Mail log có `to=<user@>`, Dovecot IMAP body, cPanel credential errors → PII leak vào VL + Qdrant embedding | Capture 1k dòng log thật mỗi loại srv → grep PII → update VRL rules → test fixture trước khi mở firewall | 1d |
| 4 | Retention policy chưa set | 500 GB/ngày × 30d = 15TB, lab spec không chịu nổi → disk full → ingest stop cascade | Set `--retentionPeriod=30d` (hoặc 14d) trên VL. Alert disk > 70%. Document retention SLA | 0.25d |
| 5 | Mock-logs service phải tắt trên prod | Lab script còn enable `mock-logs.service` → bơm fake log vào VL prod, ô nhiễm data | Verify `systemctl is-enabled mock-logs` = disabled. Remove khỏi default setup script. Add guard trong `setup-log-server.sh` | 0.25d |

**Tổng P0: ~2.5-4 ngày dev.**

---

## 4. SHOULD-FIX trong 2 tuần đầu pilot (P1)

| # | Gap | Why |
|---|---|---|
| 6 | Runbook 5 incident phổ biến: disk full VL, NATS pending lag, Vector restart loop, LLM 429, logserver reboot | 1 dev → 3 người bàn giao. `ops-cheatsheet.md` có nhưng thiếu playbook step-by-step |
| 7 | MCP bearer token rotation + revoke procedure | Bàn giao team → cần audit ai cầm token, revoke selective khi leave |
| 8 | Capacity benchmark single-node thật | Không biết khi nào chạm trigger HA roadmap §1 |
| 9 | Client-side disk queue drill (tắt logserver 1h, verify resume) | Mail/hosting mất log = mất audit evidence |
| 10 | Drain3 template explosion guard cho mail format | Postfix template đa dạng → Qdrant phình + RAG noise. Monitor `unmatched_rate`, tune sim_threshold |

---

## 5. NICE-TO-HAVE trước scale-out 50-200 srv (P2, 3-6 tháng)

- TLS + token auth port 6514/6515 (đã backlog journal 2026-06-25).
- Multi-tenant routing nếu shared hosting tách org.
- HA roadmap §2-§5 (VL cluster, Qdrant cluster, indexer scale) — chỉ trigger khi chạm threshold.
- LLM cost cap + multi-key rotation.
- Offsite backup cross-region.

---

## 6. Risk cụ thể: mail server + shared hosting vs mock log lab

Khác biệt lớn nhất, dễ bỏ sót:

1. **Log path khác mock**: Postfix `/var/log/mail.log`, Dovecot `/var/log/dovecot.log`, cPanel `/usr/local/cpanel/logs/`, Apache/Nginx vhost. Setup script rsyslog hiện forward `*.*` → có thể overshoot (kern.log, audit.log) hoặc undershoot (cPanel không qua syslog mặc định, cần file input).
2. **Volume burst**: mail server peak business + spam wave → 10× baseline trong 5 phút. Vector disk buffer + rsyslog queue phải đủ.
3. **Severity skew**: mail log toàn `info`, warn/error hiếm → nếu indexer NATS chỉ route ≥ warn thì bỏ sót pattern thường gặp. Cân nhắc lower threshold hoặc index all.
4. **Hostname**: Vector socket source auto-inject `host` từ source IP (verified 2026-06-25). OK 1 srv/IP, mất nguồn thật nếu qua reverse proxy.
5. **Time skew**: cPanel đôi khi không chrony → timestamp lệch → phá timeline RAG. Mandatory `chronyc tracking` check trong onboarding script.

---

## 7. Rollout 3-phase đề xuất

**P0 (1 tuần)** — Fix 5 must-fix §3 trên logserver. Không touch client.

**P1 (1-2 tuần)** — Pilot 1 srv mail nội bộ ít traffic nhất. Sample log thật → tune VRL redact + Drain3 → verify backup/restore drill. KHÔNG mở client #2 cho đến khi pilot stable 7 ngày.

**P2 (1 tháng)** — Onboard 2-3 srv. Build monitor dashboard + runbook. Đo capacity. Quyết định trigger HA migration.

---

## 8. Success metrics

- P0 done: `healthcheck.sh` xanh 7 ngày liên tiếp + 1 restore drill pass + 0 PII leak trên 10k dòng log thật sampled.
- P1 done: pilot srv stable 7 ngày, indexer lag < 1 phút sustained, disk growth ≤ projection.
- P2 done: 3 srv onboarded, runbook cover 5 incident, monitor dashboard live, capacity report quantify threshold §1.

---

## 9. Decision matrix

| Question | Decision |
|---|---|
| Go-live pilot ngay với stack hiện tại? | **KHÔNG** — fix 5 must-fix trước |
| Cần auth user-level trước go-live? | KHÔNG (nội bộ, accept risk) — IP whitelist + MCP bearer đủ |
| Cần TLS app-layer client→logserver? | KHÔNG (LAN + OpenVPN trust) — defer P2 |
| Cần HA migration trước scale 50 srv? | CHƯA — benchmark single-node P1 trước, quyết theo data |
| Cần Vector agent thay rsyslog client? | KHÔNG — rsyslog có sẵn trên client, JSON ECS-lite path đủ |

---

## 10. Unresolved questions

1. Logserver prod spec RAM/disk chính xác = bao nhiêu? Lab spec có thể không đủ ngay khi 500 GB/ngày dù 1 ngày.
2. Có NAS/MinIO nội bộ cho offsite snapshot, hay phải dựng?
3. Control panel hosting: cPanel / DirectAdmin / Plesk / custom? Mỗi loại log layout riêng, cần adapter VRL.
4. Postfix / Exim / Sendmail? Dovecot version?
5. Anthropic/OpenAI egress từ logserver prod qua proxy nào? RAG (nếu resurrect web/agent) cần egress; firewall block = agent crash silent.
6. Telegram bot token đã sẵn sàng cho alert P0 #2 chưa, hay cần tạo bot mới?
7. Retention SLA = 14d hay 30d (ảnh hưởng disk sizing trực tiếp)?
