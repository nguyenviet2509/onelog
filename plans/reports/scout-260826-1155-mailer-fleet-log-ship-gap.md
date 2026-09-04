# Mailer fleet — log ship gap analysis (0104 + 0204)

**Ngày**: 2026-08-26 12:00 (+07)
**Scope**: 2 host `mailer-0104` (10.10.20.13) + `mailer-0204` (10.10.20.151), cùng SSH key `~/.ssh/mailer_vps`, port 65333.
**Zimbra**: 0104 = 8.8.8 GA (2018), 0204 = 8.8.15 GA (2019 + P17). RHEL/CentOS 7.9.

---

## 1. Tổng hợp log paths (forensic-priority)

Danh sách hợp nhất từ [scout 0104](scout-260826-1143-mailer-zimbra-audit-forensic-log-paths.md) + verify trên 0204. `E`=exists non-empty, `0`=exists 0B, `–`=missing.

### Tier 1 — Auth & user action (must-ship)

| Path | 0104 | 0204 | Facility gợi ý | Tag gợi ý | Ghi chú |
|---|---|---|---|---|---|
| `/opt/zimbra/log/mailbox.log` | E 5.3G | E 4.5G | local4 | `zimbra-mailbox` | Auth Java + SoapEngine — nguồn số 1 |
| `/opt/zimbra/log/audit.log` | E 20M | E 30M | authpriv | `zimbra-audit` | cmd=Auth per protocol, easy-parse |
| `/opt/zimbra/log/imapd-audit.log` | E | – | authpriv | `zimbra-imapd-audit` | Chỉ 0104. Zimbra 8.8.15 (0204) không tách imapd → IMAP audit lẫn trong `audit.log` |
| `/opt/zimbra/log/nginx.access.log` | E 160M | E 66M | local1 | `zimbra-nginx-access` | HTTP webmail access. Rotate → `access_log.YYYY-MM-DD` |
| `/var/log/magicspam/msauthlog` | E 795M | E 1.1G | local2 | `magicspam-auth` | SMTP AUTH — brute-force detection. **CRITICAL** |

### Tier 2 — MTA / delivery

| Path | 0104 | 0204 | Facility | Tag | Ghi chú |
|---|---|---|---|---|---|
| `/var/log/maillog` | E 462M | 0 | mail (syslog) | (programname) | Postfix. Trên 0204 file rỗng → Postfix log đi đâu? cần verify |
| `/var/log/zimbra.log` | E 123M | E 106M | mail (syslog) | `zimbra` | Zimbra aggregate qua zmswatch |
| `/opt/zimbra/log/nginx.log` | E 327M | E 17M | local1 | `zimbra-nginx-err` | Nginx proxy error + IMAP/POP proxy |
| `/opt/zimbra/log/milter.log` | E | – | local1 | `zimbra-milter` | DKIM/SPF/DMARC — chỉ 0104 |

### Tier 3 — Bảo mật & admin

| Path | 0104 | 0204 | Facility | Tag | Ghi chú |
|---|---|---|---|---|---|
| `/opt/zimbra/log/zmconfigd-audit.log` | E | 0 | authpriv | `zimbra-config-audit` | Admin config change. 0204 rỗng → cần verify tại sao |
| `/opt/zimbra/log/clamd.log` | E 4.3M | E 2.6M | local3 | `zimbra-clamd` | AV scan events |
| `/opt/zimbra/log/freshclam.log` | E | E | local3 | `zimbra-freshclam` | AV signature update |
| `/opt/zimbra/log/cbpolicyd.log` | – | 0 | local3 | `zimbra-cbpolicyd` | 0204 có file nhưng rỗng → cbpolicyd chưa enable |

### Tier 4 — OS-level (đã ship qua `*.*` omfwd)

| Path | 0104 | 0204 | Ship qua | Ghi chú |
|---|---|---|---|---|
| `/var/log/secure` | E 38M | E 35M | *.* (authpriv) | SSH login, sudo, PAM |
| `/var/log/messages` | E 32M | E 329M | *.* (kern/daemon) | Kernel + systemd |

### Skip

- `/opt/zimbra/log/sync.log`, `syncstate.log`, `synctrace.log`, `wbxml.log` — 0 bytes cả 2 host (Mobile Sync FOSS disabled)
- `/opt/zimbra/log/spamtrain.log` — 0 bytes cả 2 host
- `/opt/zimbra/log/gc.log*` — JVM GC, không audit value
- `/opt/zimbra/log/hs_err_pidNNNN.log` — JVM crash dumps (0204 có 300+ files, signal instability nhưng không ship — dùng file inventory riêng)
- `/opt/zimbra/redolog/redo.log` — binary transaction log, cần parser riêng, defer

---

## 2. Đang ship gì rồi (hiện trạng)

Có **2 pipeline độc lập** trên cả 0104 + 0204:

### Pipeline A — mail_center (SSH -R tunnel → 127.0.0.1:15514)

File: `/etc/rsyslog.d/50-mailcenter.conf` — **auto-generated bởi `mail_center` — MỌI SỬA TAY BỊ GHI ĐÈ**.

- `/var/log/zimbra.log`
- `/opt/zimbra/log/mailbox.log`
- `/opt/zimbra/log/audit.log`
- `/var/lib/mailcenter/canary.log` (provisioning canary)

Format: RFC3164, tag `mc|zimbra|<host>|<filename>|:`, ruleset riêng `mcship` (queue 200k, backpressure blocking). Đích đến = mail_center receiver (không phải OneLog).

### Pipeline B — OneLog (`202.92.5.112:6514`)

File: `/etc/rsyslog.d/90-forward-onelog.conf` — `*.*` omfwd RFC5424.

**Nhận được**:
- `/var/log/messages`, `/var/log/secure` (syslog daemons)
- `/var/log/maillog` (nếu Postfix log qua mail facility) — 0104 có, 0204 rỗng ⚠️
- Kernel, systemd events

**KHÔNG nhận** (do các imfile input trên gắn ruleset `mcship`, bypass rule chính):
- `/opt/zimbra/log/mailbox.log`
- `/opt/zimbra/log/audit.log`
- `/var/log/zimbra.log`

---

## 3. Gap — cần bổ sung vào OneLog

### Gap 1 — Log Zimbra chính đang ship về mail_center nhưng KHÔNG về OneLog

Vấn đề: mail_center là hệ thống parser mail riêng, OneLog cần data này cho unified search / VL query cross-host / alerting.

**Cần thêm imfile input CHO OneLog** (không đụng vào `50-mailcenter.conf`):
- `/opt/zimbra/log/mailbox.log`
- `/opt/zimbra/log/audit.log`
- `/var/log/zimbra.log`

### Gap 2 — Log audit/forensic chưa ship đi đâu

- `/opt/zimbra/log/nginx.access.log` — HTTP webmail access (client IP + UA)
- `/opt/zimbra/log/nginx.log` — proxy errors
- `/var/log/magicspam/msauthlog` — SMTP AUTH brute-force ⭐
- `/opt/zimbra/log/imapd-audit.log` (chỉ 0104)
- `/opt/zimbra/log/milter.log` (chỉ 0104)
- `/opt/zimbra/log/zmconfigd-audit.log` (chỉ 0104 có data)

### Gap 3 — mailer-0204 maillog rỗng

`/var/log/maillog` = 0 byte trên 0204 nhưng 462MB trên 0104 → Postfix routing khác. Có thể log đã đi thẳng vào `/var/log/zimbra.log` qua zmswatch. Cần verify để không miss SMTP delivery events.

---

## 4. Đề xuất — file `/etc/rsyslog.d/85-imfile-onelog.conf`

**Ràng buộc**:
- KHÔNG đụng `50-mailcenter.conf` (bị auto-overwrite)
- KHÔNG đụng `90-forward-onelog.conf` (đã stable)
- Ruleset mặc định → messages tự chảy vào `*.* omfwd` sẵn có → tới OneLog
- Dùng `mode="polling"` (không phải inotify) — theo bài học `50-mailcenter.conf` đã ghi: rsyslog 8.24 CentOS 7 inotify kẹt khi logrotate (mất 8h data trên 0204 đêm 2026-08-05→06)
- Dùng `freshStartTail="on"` — không replay historical (nếu path chưa từng ship)
- `reopenOnTruncate="on"` — Zimbra rotate bằng cách truncate + create daily
- Wildcard path (VD `access_log.*`) chỉ khi cần — với ship live, dùng tên "hiện tại" (không rotate)

```rsyslog
module(load="imfile" mode="polling" PollingInterval="10")

# ═══ Nhóm A — Auth/Login (forensic priority) ═══

# Zimbra mailbox — auth SOAP/HTTP + user action (đang ship về mail_center, thêm route OneLog)
input(type="imfile" File="/opt/zimbra/log/mailbox.log"
      Tag="zimbra-mailbox" Severity="info" Facility="local4"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

# Zimbra audit — cmd=Auth per protocol
input(type="imfile" File="/opt/zimbra/log/audit.log"
      Tag="zimbra-audit" Severity="info" Facility="authpriv"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

# Zimbra IMAP audit (0104 only — imfile với path missing sẽ warn nhưng không fail)
input(type="imfile" File="/opt/zimbra/log/imapd-audit.log"
      Tag="zimbra-imapd-audit" Severity="info" Facility="authpriv"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

# MagicSpam SMTP AUTH — brute-force detection
input(type="imfile" File="/var/log/magicspam/msauthlog"
      Tag="magicspam-auth" Severity="notice" Facility="local2"
      PersistStateInterval="500" freshStartTail="on" reopenOnTruncate="on")

# Nginx webmail HTTP access — client IP, UA
input(type="imfile" File="/opt/zimbra/log/nginx.access.log"
      Tag="zimbra-nginx-access" Severity="info" Facility="local1"
      PersistStateInterval="500" freshStartTail="on" reopenOnTruncate="on")

# ═══ Nhóm B — Delivery / Errors ═══

# Zimbra aggregate (đang ship mail_center, thêm route OneLog)
input(type="imfile" File="/var/log/zimbra.log"
      Tag="zimbra" Severity="info" Facility="mail"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

# Nginx errors
input(type="imfile" File="/opt/zimbra/log/nginx.log"
      Tag="zimbra-nginx-err" Severity="warning" Facility="local1"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

# Milter (0104 only)
input(type="imfile" File="/opt/zimbra/log/milter.log"
      Tag="zimbra-milter" Severity="info" Facility="local1"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

# ═══ Nhóm C — Admin & AV ═══

# Admin config change (0104 has data, 0204 empty — verify sau)
input(type="imfile" File="/opt/zimbra/log/zmconfigd-audit.log"
      Tag="zimbra-config-audit" Severity="notice" Facility="authpriv"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

# ClamAV events
input(type="imfile" File="/opt/zimbra/log/clamd.log"
      Tag="zimbra-clamd" Severity="info" Facility="local3"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

# DELIBERATELY NOT SHIPPED:
# - /opt/zimbra/log/gc.log*     (JVM GC, no audit value)
# - /opt/zimbra/log/hs_err_pid*.log (JVM crash dumps — dùng inventory alert riêng)
# - /opt/zimbra/log/sync*.log   (0 bytes — Mobile Sync disabled FOSS)
# - /opt/zimbra/redolog/redo.log (binary, cần parser riêng)
# - /opt/zimbra/log/access_log.YYYY-MM-DD (đã ship qua nginx.access.log current)
```

**Lưu ý parity vs fleet syslog standard** (`docs/deployment-fleet-syslog-standard.md`):
- Fleet dùng imfile mode `inotify` PollingInterval=10 — mailer BẮT BUỘC `polling` vì rsyslog 8.24 CentOS 7 (fleet dùng CL8/9).
- Fleet dùng `PersistStateInterval="200"` — giữ nguyên, `500` cho high-volume (magicspam, nginx-access).
- Fleet auto-rollback CPU>30% — áp dụng cho mailer y hệt.

---

## 5. Deploy plan (đề xuất — chờ user duyệt)

1. **Preflight** — chạy trên từng host (verify path exist + reachability):
   ```bash
   for f in /opt/zimbra/log/mailbox.log /opt/zimbra/log/audit.log \
            /opt/zimbra/log/imapd-audit.log /var/log/magicspam/msauthlog \
            /opt/zimbra/log/nginx.access.log /var/log/zimbra.log \
            /opt/zimbra/log/nginx.log /opt/zimbra/log/milter.log \
            /opt/zimbra/log/zmconfigd-audit.log /opt/zimbra/log/clamd.log; do
     [ -f "$f" ] && echo "OK   $f" || echo "MISS $f"
   done
   timeout 3 bash -c 'cat < /dev/tcp/202.92.5.112/6514' && echo reachable
   ```
2. **Deploy 0104 canary** — write `85-imfile-onelog.conf`, `rsyslogd -N1`, restart, monitor CPU 5×15s (rollback if >30%).
3. **Verify VL** — sau 5 phút, query `programname:zimbra-mailbox host:mailer-0104` → có message không.
4. **Wait 24h stability** → apply 0204.
5. **Verify 0204 gap** — `/var/log/maillog=0` cần fix: check `postconf | grep syslog` xem mail facility đi đâu.

---

## 6. Volume estimate (rough)

Ship all Tier 1+2 tổng ~1 GB/host/day (mailbox.log dominant + magicspam). OneLog VPS hiện xử lý fleet 20+ host → thêm 2 mailer = +2GB/day, không stress.

⚠️ **Watchout**: `mailbox.log` 5.3G/host + `msauthlog` 795MB/host — cần confirm OneLog Vector reduce/dedup pipeline cover được các pattern IMAP/POP repeat để giảm noise. Xem [journal 2026-08-25 vector reclassify](../../docs/journals/2026-08-25-onelog-nats-disk-root-cause-and-vector-reclassify.md) làm chuẩn.

---

## Unresolved

1. **mailer-0204 `/var/log/maillog=0`** — Postfix log đi đâu? Kiểm tra `postconf syslog_name`, `syslog_facility` → nếu redirect vào `/var/log/zimbra.log` thì OK, không cần ship maillog. Nếu đi đâu khác → phải xác định.
2. **mailer-0204 300+ file `hs_err_pidNNNN.log`** — signal JVM crash lịch sử. Có cần alert/audit không? Không đưa vào scope ship log, nhưng nên có inventory monitor riêng.
3. **mail_center coexistence** — mail_center có track path list riêng không? Nếu team mail_center thêm path vào `50-mailcenter.conf` sau này (VD ship nginx.access.log qua mail_center), có duplicate với OneLog ship không? → Cần align với owner mail_center.
4. **Zimbra 8.8.15 vs 8.8.8** — 0104 báo `Release 8.8.8_GA` nhưng có `imapd-audit.log` (feature Zimbra 8.8.15+). Có thể là partial patch/backport → verify lại version thực với `zmcontrol -v` + `su zimbra -c 'zmversion'` để không nhầm.
5. **cbpolicyd** trên 0204 file rỗng — dịch vụ có được enable không? Nếu enable mà không log = broken. Nếu không enable = OK skip.
6. **Retention gap** — nếu OneLog gap (VD Vector down) trong lúc Zimbra rotate `access_log.YYYY-MM-DD` → mất data window. Có cần backfill từ file rotated `.gz` không?
7. **RFC3164 vs RFC5424** — mail_center BẮT BUỘC RFC3164 (đã comment ghi rõ pain đo được). OneLog forward hiện dùng RFC5424 → 2 pipeline khác format, không xung đột nhưng cần Vector parser bên OneLog xử lý được RFC5424 từ `85-imfile-onelog.conf` mới.
