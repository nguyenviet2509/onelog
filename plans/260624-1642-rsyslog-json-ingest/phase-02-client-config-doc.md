# Phase 02 — Client rsyslog config + onboarding doc

**Status:** pending
**Priority:** medium
**Effort:** ~2h
**Owner:** vietnt
**Depends on:** Phase 01

## Mục tiêu
Cung cấp template rsyslog `omfwd` JSON cho client, cập nhật doc onboarding để
liệt kê cả 2 path (RFC5424 cổ điển + JSON ECS-lite mới).

## Files
- **Create:** `infra/clients/rsyslog-forward-json.conf`
- **Modify:** `infra/clients/README.md` (nếu có) hoặc tạo mới
- **Modify:** `docs/codebase-summary.md` mục log ingestion (nếu cần)

## Implementation

### 1. Template rsyslog client
File `infra/clients/rsyslog-forward-json.conf`:
```rsyslog
# OneLog JSON forwarder (ECS-lite)
# Drop vào /etc/rsyslog.d/50-onelog.conf trên client.
# Thay <ONELOG_HOST> bằng IP/hostname OneLog server.

template(name="OneLogJSON" type="list" option.jsonf="on") {
  property(outname="@timestamp" name="timereported" dateFormat="rfc3339" format="jsonf")
  constant(value=",\"host\":{")
  property(outname="name"     name="hostname"             format="jsonf")
  constant(value="},\"log\":{")
  property(outname="level"    name="syslogseverity-text"  format="jsonf")
  constant(value="},\"service\":{")
  property(outname="name"     name="programname"          format="jsonf")
  constant(value="},")
  property(outname="message"  name="msg"                  format="jsonf")
  constant(value="\n")
}

action(
  type="omfwd"
  target="<ONELOG_HOST>" port="6515" protocol="tcp"
  template="OneLogJSON"
  queue.type="LinkedList"
  queue.filename="onelog_q"
  queue.maxdiskspace="1g"
  queue.saveOnShutdown="on"
  action.resumeRetryCount="-1"
)
```

> **Lưu ý:** rsyslog template `option.jsonf="on"` với multi-object nested cần
> verify cú pháp thực tế khi test ở Phase 03 — nếu chưa work, fallback dùng
> `type="string"` template với JSON literal string.

### 2. Onboarding doc
File `infra/clients/README.md` — thêm section mới hoặc tạo mới:

```markdown
## Client log forwarding — 2 options

### Option A: RFC5424 syslog (đơn giản, dùng template hiện có)
- File: `rsyslog-forward.conf`
- Port: 6514 TCP (RFC5424) hoặc 514 UDP (RFC3164)
- Phù hợp: client chưa có rsyslog pipeline phức tạp.

### Option B: JSON ECS-lite (cho client đã có pipeline JSON)
- File: `rsyslog-forward-json.conf`
- Port: 6515 TCP
- Phù hợp: client đã forward JSON sang ELK/SIEM khác, chỉ thêm 1 destination.
- Schema bắt buộc: `@timestamp`, `host.name`, `log.level`, `service.name`, `message`.

### Network
PoC: plain TCP, **bắt buộc** firewall whitelist IP client. Production sẽ có TLS.
```

## Todo
- [x] Tạo `infra/clients/rsyslog-forward-json.conf` template
- [x] Update / create `infra/clients/README.md` với 2 options
- [ ] Cross-reference từ `docs/codebase-summary.md` (defer — chưa biết doc structure)
- [ ] Verify cú pháp rsyslog template với `rsyslogd -N1 -f <file>` (deploy step — pending)

## Success criteria
- File template tồn tại, comment đầy đủ.
- README onboarding rõ ràng, junior dev đọc → biết chọn path nào.
- `rsyslogd -N1` không báo lỗi cú pháp template.

## Risks
- Cú pháp `option.jsonf="on"` nested object có thể không hoạt động trên rsyslog
  < 8.x. Verify version client tối thiểu. Backup: dùng flat JSON
  (`host`, `level`, `service` flat thay vì nested), sửa transform normalize
  ở Phase 01 tương ứng.
