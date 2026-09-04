# zmhn022606 log ship gap — scout & compare với mailer

**Date**: 2026-08-26 14:22 (+07)
**Host**: `zmhn022606` = `zmhn022606.onemail.vn` (10.10.20.28, port 65333)
**Env**: Rocky Linux 8.10, Zimbra **8.8.15 BETA P45**, rsyslog **8.2102.0** (aka 2021.02, Feb 2021)
**Scope**: xem path có giống mailer-0104/0204 không, phát hiện gap OneLog forward.

---

## 1. Compare với mailer-0104/0204

| Aspect | mailer-0104 | mailer-0204 | **zmhn022606** |
|---|---|---|---|
| OS | RHEL7/CentOS 7.9 | RHEL7/CentOS 7.9 | **Rocky Linux 8.10** ⚠️ |
| Zimbra | 8.8.8 GA | 8.8.15 P17 | **8.8.15 P45 BETA** |
| rsyslog | **8.24** | **8.24** | **8.2102.0** ⚠️ (10 năm mới hơn) |
| Domain | inet.vn | inet.vn | **onemail.vn** |
| `50-mailcenter.conf` | ✅ | ✅ | ✅ (auto-managed) |
| `90-forward-onelog.conf` | ✅ (deploy hôm nay) | ✅ (deploy hôm nay) | ❌ **CHƯA có** |
| `85-imfile-onelog.conf` | ✅ | ✅ | ❌ **CHƯA có** |
| `55-onelog-ship.conf` | ✅ | ✅ | ❌ **CHƯA có** |

**⇒ zmhn022606 hoàn toàn CHƯA ship gì về OneLog** — chỉ có mail_center pipeline. Là host mới cần onboard.

---

## 2. Log paths — verify vs template Loại 3

### Nhóm A — Auth/Login

| Path | zmhn022606 | mailer-0104 | mailer-0204 | Note |
|---|---|---|---|---|
| `/opt/zimbra/log/mailbox.log` | ✅ 1.3 G | 5.3 G | 4.5 G | Nhỏ hơn (nginx traffic hơn mail?) |
| `/opt/zimbra/log/audit.log` | ✅ 6.7 M | 20 M | 30 M | Active |
| `/opt/zimbra/log/imapd-audit.log` | ❌ MISS | ✅ | ❌ | 8.8.15 subset — imapd audit gộp vào audit.log |
| `/opt/zimbra/log/nginx.access.log` | ✅ **4.5 G** | 160 M | 66 M | ⚠️ **HUGE** — 30× hơn mailer |
| `/var/log/magicspam/msauthlog` | ✅ **230 K ACTIVE** | 795 M stale | 1.1 G stale | 🎯 **Khác biệt lớn** — msauthlog HOẠT ĐỘNG (mtime 14:20). MagicSpam AUTH log ship được! |
| `/opt/zimbra/log/zmconfigd-audit.log` | 0 (mar-2026) | có data | 0 | Chưa có admin change |

### Nhóm B — Delivery / Aggregate

| Path | zmhn022606 | Mailer note |
|---|---|---|
| `/var/log/zimbra.log` | ✅ 33 M | Postfix qua zmswatch |
| `/opt/zimbra/log/nginx.log` | ✅ **13 G** ⚠️ | Cực lớn — 40× hơn mailer-0104 (327M) |
| `/opt/zimbra/log/milter.log` | ❌ MISS | Không có (khác mailer-0104) |
| `/var/log/maillog` | 0 (rotate weekly) | Giống mailer-0204 — Postfix routed vào zimbra.log |

### Nhóm C — Application

| Path | zmhn022606 | Note |
|---|---|---|
| `/opt/zimbra/log/clamd.log` | ✅ 1.5 M | Low volume |
| `/opt/zimbra/log/cbpolicyd.log` | ❌ MISS | Không có |
| `/opt/zimbra/redolog/redo.log` | 2.5 G | Binary transaction |

### OS

| Path | zmhn022606 |
|---|---|
| `/var/log/secure` | ✅ 30 M |
| `/var/log/messages` | ✅ 51 M |

---

## 3. Gap analysis

### Gap 1 — CHƯA có OneLog forward pipeline

Host chỉ có `50-mailcenter.conf`. Cần build **3 file cấu hình** để onboard vào OneLog:
- `90-forward-onelog.conf` — main `*.*` omfwd → 202.92.5.112:6514
- `85-imfile-onelog.conf` — imfile inputs cho các file KHÔNG bị mcship claim
- `55-onelog-ship.conf` — dedicated ruleset ship 3 file mcship-claim qua symlink

### Gap 2 — Volume warning ⚠️

- `nginx.access.log` **4.5 G** (30× mailer-0104)
- `nginx.log` **13 G** (40× mailer-0104)
- `mailbox.log` 1.3 G

Total daily volume ước tính > mailer-0104. **Queue `maxDiskSpace=2g` có thể không đủ** — cần bump lên **4g** cho zmhn022606.

### Gap 3 — MagicSpam msauthlog ACTIVE

Khác mailer (stale) — trên zmhn022606 file **đang ghi**. Có thể ship MagicSpam auth log riêng (không cần fallback về saslauthd):

```
input(type="imfile" File="/var/log/magicspam/msauthlog"
      Tag="magicspam-auth" Severity="notice" Facility="local2"
      PersistStateInterval="500" freshStartTail="on" reopenOnTruncate="on")
```

---

## 4. Ưu điểm zmhn022606 vs mailer

### rsyslog 8.2102.0 (Feb 2021, so với 8.24 Jan 2017 trên mailer)

- ✅ **`freshStartTail="on"` HOẠT ĐỘNG** — không cần pre-populate state file (workaround #2 Loại 3 KHÔNG cần)
- ✅ **`imfile` inotify** có thể ổn định hơn — vẫn nên test polling trước để an toàn (nhưng có thể switch inotify sau)
- ✅ **Config validator tốt hơn** — bắt lỗi rõ hơn

### Symlink workaround vẫn cần?

Test cần thiết: rsyslog **8.2102** có cho 2 imfile input đọc cùng file không? Nếu có → **KHÔNG cần symlink**, chỉ cần input mới với ruleset khác. Nếu không → vẫn cần symlink.

Cần thí nghiệm nhỏ trước deploy full config.

---

## 5. Đề xuất — Deploy plan cho zmhn022606

### Bước A — Test 2-imfile-per-file (verify rsyslog 8.2102 fix bug)

Thí nghiệm nhanh trên zmhn022606:
```
input(type="imfile" File="/opt/zimbra/log/mailbox.log"
      Tag="test-mailbox" ruleset="test_ruleset" freshStartTail="on")
```

Chạy 2 phút, check state file + verify 50-mailcenter mcship state không bị đụng, verify test ruleset nhận data.

- Nếu test PASS → không cần symlink workaround, deploy `85-imfile-onelog.conf` trực tiếp với 3 file, không cần 55/symlink/state pre-populate
- Nếu test FAIL → dùng symlink approach y hệt mailer (Section 3 KB page 1148)

### Bước B — Config theo kết quả test A

**Option A (rsyslog 8.2102 fix bug)** — simpler:
- `90-forward-onelog.conf` (queue.maxDiskSpace=**4g** thay vì 2g)
- `85-imfile-onelog.conf` (9 imfile input, KHÔNG bao gồm 3 file mcship claim, KHÔNG dùng ruleset custom — messages chảy vào default → `*.*` → OneLog)
  Wait — 3 file `mailbox.log`, `audit.log`, `zimbra.log` vẫn bị 50-mailcenter claim ruleset "mcship" → hết đường chảy qua default. Vẫn cần symlink hoặc dedicated input path/tag.

**Option B (fallback symlink)** — y hệt Loại 3:
- `90-forward-onelog.conf` (queue=4g)
- `85-imfile-onelog.conf`
- `55-onelog-ship.conf` (symlink + dedicated ruleset)
- Cron 07:30 refresh symlink
- (Không cần pre-populate state nếu freshStartTail hoạt động)

**Kiến nghị**: Chạy Bước A test, nếu 2-imfile-per-file HOẠT ĐỘNG với ruleset khác → simpler. Nếu vẫn conflict → dùng symlink nhưng bỏ pre-populate state (dùng freshStartTail).

### Bước C — Bổ sung MagicSpam msauthlog (khác Loại 3 template)

zmhn022606 msauthlog active → thêm 1 input riêng cho `magicspam-auth` tag.

---

## 6. So sánh với KB Loại 3 (đã push kb.inet.vn)

KB Loại 3 assume:
- rsyslog v8.24 (RHEL 7)
- msauthlog stale
- Zimbra 8.8.8/8.8.15 P17

zmhn022606 KHÁC 3 điểm:
1. rsyslog 8.2102 (Rocky 8) → có freshStartTail, có thể có 2-imfile support
2. msauthlog active → ship được
3. Volume nginx cao 40× → queue cần lớn hơn

**Kiến nghị**: Sau khi deploy zmhn022606 thành công, **update KB Loại 3** thành 2 variants:
- **3a — Mailer (rsyslog v8.24 RHEL 7)**: nội dung hiện tại, workaround pre-populate state
- **3b — zmhn (rsyslog 8.2102 Rocky 8)**: variant với freshStartTail, queue 4g, msauthlog active

Hoặc: Nếu zmhn fleet lớn dần (nhiều zmhn* host), tách thành **Loại 4** riêng.

---

## 7. Unresolved

1. **Có bao nhiêu zmhn* host trong fleet?** alertmanager pattern `zmhn[a-z0-9]+(\.onemail\.vn)?` — cần list đầy đủ để cân nhắc tách Loại 4 hay merge 3b.
2. **rsyslog 8.2102 có fix "1 imfile watcher/file" bug không?** Cần test trước khi bỏ symlink workaround.
3. **nginx.access.log 4.5G/day — có nên ship all hay filter?** Volume cao có thể spam OneLog. Cân nhắc filter chỉ giữ non-2xx status hoặc auth-related paths.
4. **nginx.log 13G/day** — hầu hết là gì? Nếu là proxy debug/verbose thì filter mạnh. Nếu là IMAP/POP proxy access thì giữ.
5. **msauthlog 230K/last-minute** — tốc độ ghi bao nhiêu/ngày? Cần estimate để check queue.
6. **zmhn022606 = "onemail.vn" domain** — có cluster riêng cho mail server dịch vụ khác Zimbra "inet.vn" không? Ảnh hưởng gì đến ship path?
