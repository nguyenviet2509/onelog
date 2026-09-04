# Scout: mailer Zimbra log paths (audit + forensic)

- **Host**: `mailer` = `mailer-0104.inet.vn` (10.10.20.13)
- **Zimbra**: 8.8.8_GA_2009 FOSS, RHEL7 x86_64
- **Date**: 2026-08-26 11:48 (+07)
- **/opt/zimbra/log size**: ~66 GB
- **Scope**: Đối chiếu danh sách article với thực tế + phát hiện log bổ sung

---

## 1. Đối chiếu article ↔ thực tế

| Article path | Thực tế | Ghi chú |
|---|---|---|
| `/opt/zimbra/log/mailbox.log` | ✅ **5.3 G** active | Auth Java + SoapEngine, log user-action chính |
| `/opt/zimbra/log/audit.log` | ✅ **20 M** active + rotate `.gz` daily giữ ~10 ngày | IMAP/POP/SOAP auth, cmd=Auth events |
| `/opt/zimbra/log/access_log` | ❌ **KHÔNG có** file này | Zimbra 8.8.8 chỉ có `access_log.YYYY-MM-DD` (rotate daily, 100–400 MB/ngày). Xem mục 2 dưới đây. |
| `/opt/zimbra/log/sync.log` | ⚠️ **0 bytes** từ 2022 | ActiveSync/EAS không license trong FOSS → log rỗng vĩnh viễn |
| `/var/log/zimbra.log` | ✅ **123 M** active + `.gz` daily | Postfix rsyslog aggregate (do zmswatch feed) |
| `/var/log/mail.log` | ❌ **KHÔNG có** | RHEL dùng `/var/log/maillog` thay thế (462 M active + rotate 7 ngày) |
| `/opt/zimbra/log/cbpolicyd.log` | ❌ **KHÔNG có** | cbpolicyd không enable trên máy này |
| `/opt/zimbra/log/convertd.log` | ❌ **KHÔNG có** | convertd không cài |
| `/opt/zimbra/log/clamd.log` | ✅ 4.3 M | ClamAV có chạy |
| `/opt/zimbra/log/spamtrain.log` | ⚠️ 0 bytes | Chưa có user train spam qua Junk/NotJunk |
| `/opt/zimbra/log/zmmailboxd.out` | ✅ 14 M | Mailbox daemon stdout |

**Tổng kết đối chiếu**: 6/11 path article đúng, 3 path sai (không tồn tại trên bản FOSS 8.8.8), 2 path tồn tại nhưng rỗng.

---

## 2. Log audit/forensic THỰC SỰ QUAN TRỌNG (thứ tự ưu tiên)

### Tier 1 — Auth & user action (must-have cho forensic)

| Path | Size | Vai trò |
|---|---|---|
| `/opt/zimbra/log/mailbox.log` | 5.3 G | Auth SOAP/HTTP, thao tác mailbox chi tiết. Nguồn số 1. |
| `/opt/zimbra/log/audit.log` | 20 M | `cmd=Auth` per protocol (imap/pop3/soap) — dễ parse nhất cho brute-force. Rotate daily, giữ 10 ngày `.gz`. |
| `/opt/zimbra/log/imapd-audit.log` | có | **Article thiếu**. IMAP audit riêng cho imapd (Zimbra 8.8+). |
| `/opt/zimbra/log/nginx.access.log` | 160 M | **Article gọi nhầm là `access_log`**. Current-day nginx proxy — chứa client IP, UA, URL webmail. Rotate → `access_log.YYYY-MM-DD`. |
| `/var/log/magicspam/msauthlog` | 795 M active + rotate | **Article thiếu**. MagicSpam auth log riêng — SMTP AUTH events, brute-force detection. 14 GB total historical. |

### Tier 2 — MTA / mail delivery

| Path | Size | Vai trò |
|---|---|---|
| `/var/log/maillog` | 462 M active + 4 weekly rotate (~1 GB/tuần) | **Postfix chính** (article gọi nhầm `mail.log`) — smtp in/out, delivery, reject |
| `/var/log/zimbra.log` | 123 M | Zimbra postfix aggregate (rsyslog feed) |
| `/opt/zimbra/log/nginx.log` | 327 M | Nginx proxy error + IMAP/POP/HTTP proxy |
| `/opt/zimbra/log/milter.log` | có | Milter events (DKIM/SPF/DMARC filter) |

### Tier 3 — Bảo mật hỗ trợ

| Path | Vai trò |
|---|---|
| `/opt/zimbra/log/clamd.log` | ClamAV scan events |
| `/opt/zimbra/log/freshclam.log` | ClamAV signature update |
| `/opt/zimbra/log/zmconfigd-audit.log` | **Article thiếu**. Audit thay đổi config Zimbra (admin action). |
| `/opt/zimbra/log/zmbackup.log` + `zmbackup-cron.log` | Backup activity — forensic timeline |
| `/opt/zimbra/redolog/redo.log` | **Article thiếu**. Redo log giao dịch mailbox — vàng cho point-in-time restore + forensic reconstruction |
| `/var/log/magicspam/error.log` | MagicSpam runtime errors |

### Tier 4 — OS-level

| Path | Vai trò |
|---|---|
| `/var/log/secure` | 38 M — SSH login, sudo, PAM (kẻ tấn công vào shell) |
| `/var/log/messages` | 32 M — syslog general (kernel, systemd, cron) |

---

## 3. Log KHÔNG dùng được (rỗng / disable)

- `/opt/zimbra/log/sync.log`, `syncstate.log`, `synctrace.log`, `wbxml.log` — Mobile Sync tắt (FOSS)
- `/opt/zimbra/log/spamtrain.log` — chưa có ai train
- `/opt/zimbra/log/activity.log`, `ews.log` — 0 bytes từ 2022, feature disable

---

## 4. Log rotation pattern quan sát được

- `access_log` (nginx proxy) → rotate daily 06:59, giữ toàn bộ ~30 ngày plain-text (không nén) — tổng ~9 GB
- `audit.log` → rotate daily 02:50, giữ ~10 ngày `.gz`
- `maillog` (RHEL rsyslog) → rotate weekly, giữ 4 tuần plain-text
- `zimbra.log` (Zimbra syslog) → rotate daily 03:xx, giữ vài ngày `.gz`
- `gc.log.N` → JVM GC, rotate theo size (~11 MB × N)
- `trace_log.YYYY_MM_DD` → 10 ngày gần nhất

⚠️ **Forensic window thực tế**: 10 ngày (audit.log giới hạn), 30 ngày (access_log), 4 tuần (maillog). Nếu cần retention dài hơn → phải ship sang OneLog trước khi rotate xóa.

---

## 5. Recommendation cho pipeline OneLog

Ưu tiên ship sang OneLog (Vector/rsyslog forward) theo thứ tự:

1. **`/opt/zimbra/log/audit.log`** — auth events chuẩn hóa, dễ parse nhất
2. **`/var/log/magicspam/msauthlog`** — SMTP AUTH brute-force detection
3. **`/opt/zimbra/log/mailbox.log`** — grep `AuthProvider|SoapEngine.*auth`
4. **`/opt/zimbra/log/nginx.access.log`** — HTTP access chi tiết
5. **`/var/log/maillog`** — Postfix delivery
6. **`/var/log/secure`** — OS auth (SSH/sudo)
7. **`/opt/zimbra/log/zmconfigd-audit.log`** — admin config change

Các log tier 3 khác (clamd, milter, backup) → ship nếu cần compliance rộng, không critical cho forensic auth path.

---

## Unresolved

- Có cần capture cả `/opt/zimbra/redolog/redo.log` (mailbox transaction) không? Đây là binary format, size lớn (~GB), forensic value cao nhưng khó ingest raw → có thể cần parser riêng.
- MagicSpam có REST/DB export riêng để lấy structured events thay vì tail file text 795 MB không? Cần check `/etc/magicspam/` config.
- `access_log.YYYY-MM-DD` plain-text 30 ngày = ~9 GB. Ship all vs sample?
- Timezone server chưa verify là `Asia/Ho_Chi_Minh` (log show `+0700` → OK, khớp Saigon).
