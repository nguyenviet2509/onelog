# Ansible files — content của 4 cặp file `-a`/`-b` (mail fleet)

**Date**: 2026-08-26
**Context**: Ansible layout cho KB 1159 (mail server). Mỗi cặp file dùng chung template, khác nhau ở param nhỏ theo variant rsyslog version + volume.

---

## Cặp 1: `55-onelog-ship-{a,b}.conf`

Dedicated ruleset ship 3 file `mailbox.log`/`audit.log`/`zimbra.log` qua symlink `/var/log/onelog-ship/*`.

### `files/55-onelog-ship-a.conf` (Mailer / RHEL 7 / rsyslog v8.24)

```rsyslog
# Symlink-based fanout tới OneLog cho 3 file bị 50-mailcenter claim (mcship ruleset).
# Dedicated ruleset "onelog_ship" với queue riêng → KHÔNG đụng main pipeline.
# rsyslog v8.24 KHÔNG có freshStartTail → state file pre-populated ngoài (Sub-step 4 script deploy).
# reopenOnTruncate xử lý Zimbra copytruncate rotation.

template(name="onelog_rfc5424" type="string"
  string="<%PRI%>1 %TIMESTAMP:::date-rfc3339% %HOSTNAME% %APP-NAME% %PROCID% %MSGID% - %msg%\n")

ruleset(name="onelog_ship"
        queue.type="linkedList"
        queue.size="50000"
        queue.dequeueBatchSize="200"
        queue.filename="onelog_ship"
        queue.maxDiskSpace="2g"
        queue.saveOnShutdown="on"
        queue.timeoutEnqueue="10000") {
    action(type="omfwd"
           target="202.92.5.112" port="6514" protocol="tcp"
           template="onelog_rfc5424"
           action.resumeRetryCount="-1")
}

input(type="imfile" File="/var/log/onelog-ship/mailbox.log"
      Tag="zimbra-mailbox" Severity="info" Facility="local4"
      ruleset="onelog_ship"
      PersistStateInterval="200" reopenOnTruncate="on")

input(type="imfile" File="/var/log/onelog-ship/audit.log"
      Tag="zimbra-audit" Severity="info" Facility="authpriv"
      ruleset="onelog_ship"
      PersistStateInterval="200" reopenOnTruncate="on")

input(type="imfile" File="/var/log/onelog-ship/zimbra.log"
      Tag="zimbra-log" Severity="info" Facility="mail"
      ruleset="onelog_ship"
      PersistStateInterval="200" reopenOnTruncate="on")
```

### `files/55-onelog-ship-b.conf` (zmhn / Rocky 8 / rsyslog v8.2102)

```rsyslog
# rsyslog 8.2102 — freshStartTail hoạt động, KHÔNG cần pre-populate state ngoài.
# Queue 4g (nginx volume trên zmhn 40× lớn hơn mailer).

template(name="onelog_rfc5424" type="string"
  string="<%PRI%>1 %TIMESTAMP:::date-rfc3339% %HOSTNAME% %APP-NAME% %PROCID% %MSGID% - %msg%\n")

ruleset(name="onelog_ship"
        queue.type="linkedList"
        queue.size="50000"
        queue.dequeueBatchSize="200"
        queue.filename="onelog_ship"
        queue.maxDiskSpace="4g"
        queue.saveOnShutdown="on"
        queue.timeoutEnqueue="10000") {
    action(type="omfwd"
           target="202.92.5.112" port="6514" protocol="tcp"
           template="onelog_rfc5424"
           action.resumeRetryCount="-1")
}

input(type="imfile" File="/var/log/onelog-ship/mailbox.log"
      Tag="zimbra-mailbox" Severity="info" Facility="local4"
      ruleset="onelog_ship"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

input(type="imfile" File="/var/log/onelog-ship/audit.log"
      Tag="zimbra-audit" Severity="info" Facility="authpriv"
      ruleset="onelog_ship"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

input(type="imfile" File="/var/log/onelog-ship/zimbra.log"
      Tag="zimbra-log" Severity="info" Facility="mail"
      ruleset="onelog_ship"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")
```

**Diff**: `queue.maxDiskSpace="2g"` → `"4g"`, và **thêm** `freshStartTail="on"` vào 3 input.

---

## Cặp 2: `85-imfile-onelog-{a,b}.conf`

Imfile input cho file KHÔNG bị 50-mailcenter claim. Chảy vào default ruleset → `*.* omfwd` → OneLog.

### `files/85-imfile-onelog-a.conf` (Mailer)

```rsyslog
# Zimbra imfile fanout → default ruleset → *.* omfwd → OneLog.
# ⚠ mode="polling" ĐÃ load bởi 50-mailcenter.conf — KHÔNG load lại (error 2221 duplicate).
# ⚠ 3 file mailbox.log/audit.log/zimbra.log bị 50-mailcenter claim → ship qua 55-onelog-ship-a.conf.
# ⚠ freshStartTail bị rsyslog v8.24 ignore — nhưng vẫn để đây, không harm.
# ⚠ magicspam/msauthlog STALE từ 2025-08-06 trên mailer-0104/0204 → KHÔNG include (commented).

input(type="imfile" File="/opt/zimbra/log/nginx.access.log"
      Tag="zimbra-nginx-access" Severity="info" Facility="local1"
      PersistStateInterval="500" freshStartTail="on" reopenOnTruncate="on")

input(type="imfile" File="/opt/zimbra/log/nginx.log"
      Tag="zimbra-nginx-err" Severity="warning" Facility="local1"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

input(type="imfile" File="/opt/zimbra/log/clamd.log"
      Tag="zimbra-clamd" Severity="info" Facility="local3"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

input(type="imfile" File="/opt/zimbra/log/imapd-audit.log"
      Tag="zimbra-imapd-audit" Severity="info" Facility="authpriv"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

input(type="imfile" File="/opt/zimbra/log/milter.log"
      Tag="zimbra-milter" Severity="info" Facility="local1"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

input(type="imfile" File="/opt/zimbra/log/zmconfigd-audit.log"
      Tag="zimbra-config-audit" Severity="notice" Facility="authpriv"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

# MagicSpam msauthlog — STALE trên mailer-0104/0204 (mtime 2025-08-06).
# Nếu preflight cho thấy active → uncomment block dưới:
#input(type="imfile" File="/var/log/magicspam/msauthlog"
#      Tag="magicspam-auth" Severity="notice" Facility="local2"
#      PersistStateInterval="500" freshStartTail="on" reopenOnTruncate="on")
```

### `files/85-imfile-onelog-b.conf` (zmhn)

```rsyslog
# rsyslog 8.2102 (Rocky 8) — freshStartTail hoạt động, không cần pre-populate state.
# MagicSpam msauthlog ACTIVE trên zmhn (mtime hiện tại) → ship.

input(type="imfile" File="/opt/zimbra/log/nginx.access.log"
      Tag="zimbra-nginx-access" Severity="info" Facility="local1"
      PersistStateInterval="500" freshStartTail="on" reopenOnTruncate="on")

input(type="imfile" File="/opt/zimbra/log/nginx.log"
      Tag="zimbra-nginx-err" Severity="warning" Facility="local1"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

input(type="imfile" File="/opt/zimbra/log/clamd.log"
      Tag="zimbra-clamd" Severity="info" Facility="local3"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

input(type="imfile" File="/opt/zimbra/log/imapd-audit.log"
      Tag="zimbra-imapd-audit" Severity="info" Facility="authpriv"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

input(type="imfile" File="/opt/zimbra/log/milter.log"
      Tag="zimbra-milter" Severity="info" Facility="local1"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

input(type="imfile" File="/opt/zimbra/log/zmconfigd-audit.log"
      Tag="zimbra-config-audit" Severity="notice" Facility="authpriv"
      PersistStateInterval="200" freshStartTail="on" reopenOnTruncate="on")

# MagicSpam auth log — ACTIVE trên zmhn (khác mailer stale).
input(type="imfile" File="/var/log/magicspam/msauthlog"
      Tag="magicspam-auth" Severity="notice" Facility="local2"
      PersistStateInterval="500" freshStartTail="on" reopenOnTruncate="on")
```

**Diff**: `-b` uncomment magicspam-auth input. 6 input còn lại y hệt.

---

## Cặp 3: `90-forward-onelog-{a,b}.conf`

Main forward pipeline `*.*` → OneLog `202.92.5.112:6514` với noise filter kernel/systemd/rsyslogd.

### `files/90-forward-onelog-a.conf` (Mailer, queue 2g)

```rsyslog
# Forward tới OneLog logserver (TCP 6514, RFC5424)
template(name="ragstack_fmt" type="string"
  string="<%PRI%>1 %TIMESTAMP:::date-rfc3339% %HOSTNAME% %APP-NAME% %PROCID% %MSGID% - %msg%\n"
)

# Kernel noise
if $programname == "kernel" and (
     $msg contains "audit_copy_inode" or $msg contains "path_openat"
  or $msg contains "filename_lookup" or $msg contains "alloc_empty_file"
  or $msg contains "do_filp_open"
  or $msg contains "CPG DoS Monitoring"
) then stop

# node_exporter cage FS
if $programname == "node_exporter" and $msg contains "operation not permitted" then stop

# systemd noise
if $programname == "systemd" and (
     $msg contains "custom bouncer for CrowdSec"
  or $msg contains "firewall bouncer for CrowdSec"
  or $msg contains "crowdsec-custom-bouncer.service"
  or $msg contains "crowdsec-firewall-bouncer.service"
  or $msg contains "Started Session" or $msg contains "Stopped Session"
  or $msg contains "Starting Session"
  or $msg contains "target Timers" or $msg contains "target Sockets"
  or $msg contains "target Paths" or $msg contains "Mark boot as successful"
) then stop

# rsyslog self-noise
if $programname == "rsyslogd" and (
     $msg contains "is FILE but DIRECTORY expected"
  or $msg contains "cannot obtain inode"
  or $msg contains "already in wdmap"
  or $msg contains "journal files changed"
) then stop

# Fallback: kernel/systemd severity > 4 (giữ OOM = sev 4)
if ($programname == "kernel" or $programname == "systemd") and $syslogseverity > 4 then stop

*.* action(type="omfwd"
  target="202.92.5.112" port="6514" protocol="tcp"
  template="ragstack_fmt"
  action.resumeRetryCount="-1"
  queue.type="LinkedList" queue.size="10000"
  queue.filename="onelog_fwd" queue.saveOnShutdown="on"
  queue.maxDiskSpace="2g"
)
```

### `files/90-forward-onelog-b.conf` (zmhn, queue 4g)

Nội dung y hệt `-a` **trừ 1 dòng cuối**:

```rsyslog
  queue.maxDiskSpace="4g"
```

**Diff**: `queue.maxDiskSpace="2g"` → `"4g"`. Còn lại 100% giống nhau.

---

## Cặp 4: `onelog-ship-symlink-refresh-{a,b}`

Cron file `/etc/cron.d/onelog-ship-symlink-refresh` chạy 07:30 daily sau Zimbra logrotate.

### `files/onelog-ship-symlink-refresh-a` (Mailer — refresh symlink + rebuild state + restart)

```cron
# Post-Zimbra-rotation refresh (07:30 daily) — Loại a.
# Refresh symlink + REBUILD state file với curr_offs=EOF (v8.24 không có freshStartTail).
# Restart rsyslog để đọc state mới.
30 7 * * * root bash -c 'for f in mailbox.log audit.log zimbra.log; do case $f in mailbox.log|audit.log) T=/opt/zimbra/log/$f;; zimbra.log) T=/var/log/zimbra.log;; esac; ln -sfn "$T" "/var/log/onelog-ship/$f"; INO=$(stat -Lc %i "/var/log/onelog-ship/$f" 2>/dev/null); SZ=$(stat -Lc %s "/var/log/onelog-ship/$f" 2>/dev/null); [ -n "$INO" ] && printf "{ \"filename\": \"/var/log/onelog-ship/%s\", \"prev_was_nl\": 0, \"curr_offs\": %d, \"strt_offs\": %d }" "$f" "$SZ" "$SZ" > "/var/lib/rsyslog/imfile-state:$INO"; done; /usr/bin/systemctl restart rsyslog'
```

### `files/onelog-ship-symlink-refresh-b` (zmhn — chỉ refresh symlink + HUP)

```cron
# Post-Zimbra-rotation refresh (07:30 daily) — Loại b.
# Chỉ refresh symlink target + HUP rsyslog reopen file. freshStartTail tự xử lý tail file mới.
30 7 * * * root ln -sfn /opt/zimbra/log/mailbox.log /var/log/onelog-ship/mailbox.log && ln -sfn /opt/zimbra/log/audit.log /var/log/onelog-ship/audit.log && ln -sfn /var/log/zimbra.log /var/log/onelog-ship/zimbra.log && /usr/bin/systemctl kill -s HUP rsyslog
```

**Diff**:
- `-a` có logic rebuild `/var/lib/rsyslog/imfile-state:$INO` với offset=EOF, và **restart** rsyslog
- `-b` chỉ symlink + **HUP** rsyslog (reopen file handle, không full restart)

---

## Summary matrix

| File | Diff giữa `-a` và `-b` | Root cause |
|---|---|---|
| `55-onelog-ship-*.conf` | queue 2g→4g; thêm `freshStartTail="on"` | v8.2102 hỗ trợ freshStartTail; nginx volume zmhn cao hơn |
| `85-imfile-onelog-*.conf` | `-b` uncomment magicspam-auth input | msauthlog stale trên mailer, active trên zmhn |
| `90-forward-onelog-*.conf` | queue 2g→4g (1 dòng) | Volume zmhn cao hơn |
| `onelog-ship-symlink-refresh-*` | `-a` rebuild state + restart; `-b` chỉ HUP | v8.24 không tự tail file mới; v8.2102 tự xử lý |

**8 file total** = 4 cặp × 2 variant. Toàn bộ khác biệt gói gọn trong 2 điểm root cause: rsyslog version (v8.24 vs v8.2102) + volume nginx.
