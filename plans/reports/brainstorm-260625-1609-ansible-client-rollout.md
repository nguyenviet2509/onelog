# Brainstorm — Ansible rollout cho 50-200 OneLog clients

**Date:** 2026-06-25 16:09 (Asia/Saigon)
**Owner:** trihd@inet.vn
**Context:** Onboard 50-200 client server (Ubuntu, mail + shared hosting, rsyslog có sẵn) forward log về OneLog logserver. Team biết Ansible cơ bản, muốn setup tối thiểu. SSH key + sudo cần password. Rollout canary → batch 10 → 50 → 200.

---

## 1. Nguyên tắc design

- **KISS**: 1 playbook + 1 inventory + 1 template. Không roles, không collections ngoài stdlib.
- **DRY**: Native Ansible modules (apt/template/service). KHÔNG wrap `setup-rsyslog-client.sh` qua `shell` — mất idempotency, check mode, per-host templating.
- **YAGNI**: Chưa cần Vault, chưa cần dynamic inventory. Bổ sung khi thực sự cần.

---

## 2. Cấu trúc thư mục

```
infra/ansible/
├── ansible.cfg                        # forks, host_key_checking, pipelining
├── inventory.ini                      # groups canary / batch_10 / batch_50 / batch_200
├── playbook-onelog-client.yml         # ~80 dòng, 6 task chính
├── templates/
│   └── 90-forward-onelog.conf.j2      # rsyslog forward + queue
└── README.md                          # 5 lệnh canary/batch
```

Tổng ~150 dòng YAML.

---

## 3. Inventory groups + rollout cadence

```ini
[canary]
srv-mail-pilot ansible_host=10.0.1.10 onelog_role=mail

[batch_10]
# 10 srv

[batch_50]
# 40 srv tiếp

[batch_200]
# 150 srv còn lại

[all_onelog:children]
canary
batch_10
batch_50
batch_200

[all_onelog:vars]
log_server_ip=10.0.0.53
log_server_port=6514
rsyslog_queue_maxdisk=500m
```

Lệnh chạy:
```bash
# Canary dry-run → real
ansible-playbook -i inventory.ini playbook-onelog-client.yml -l canary --ask-become-pass --check --diff
ansible-playbook -i inventory.ini playbook-onelog-client.yml -l canary --ask-become-pass

# Soak 24h verify VL ingest + disk growth

# Batch 10
ansible-playbook ... -l batch_10 --ask-become-pass --forks 10

# Batch 50 / 200
ansible-playbook ... -l batch_50 --forks 20
ansible-playbook ... -l batch_200 --forks 20
```

---

## 4. Playbook outline

```yaml
- name: Setup OneLog rsyslog client
  hosts: all_onelog
  become: yes
  serial: "20%"
  any_errors_fatal: false
  max_fail_percentage: 10
  gather_facts: yes
  pre_tasks:
    - assert: that=ansible_distribution == "Ubuntu"
  tasks:
    - apt: name=[rsyslog, chrony] state=present cache_valid_time=3600
    - systemd: name=chrony enabled=yes state=started
    - shell: backup conflicting /etc/rsyslog.d/*-forward*.conf
    - template:
        src: 90-forward-onelog.conf.j2
        dest: /etc/rsyslog.d/90-forward-onelog.conf
        validate: 'rsyslogd -N1 -f %s'
      notify: restart rsyslog
    - meta: flush_handlers
    - wait_for: host={{log_server_ip}} port={{log_server_port}} timeout=10
    - command: logger -t onelog-ansible "verified host={{inventory_hostname}}"
  handlers:
    - systemd: name=rsyslog state=restarted
```

Key points:
- `validate: 'rsyslogd -N1 -f %s'` → syntax-check trước commit
- `flush_handlers` → restart trước verify port
- `serial: 20%` → rolling deploy
- `max_fail_percentage: 10` → abort nếu > 10% fail

---

## 5. Template `90-forward-onelog.conf.j2`

```jinja
# Managed by Ansible
template(name="ragstack_fmt" type="string"
  string="<%PRI%>1 %TIMESTAMP:::date-rfc3339% %HOSTNAME% %APP-NAME% %PROCID% %MSGID% - %msg%\n")
*.* action(type="omfwd"
  target="{{ log_server_ip }}"
  port="{{ log_server_port }}"
  protocol="tcp"
  template="ragstack_fmt"
  action.resumeRetryCount="-1"
  queue.type="LinkedList"
  queue.size="10000"
  queue.filename="onelog_fwd"
  queue.saveOnShutdown="on"
  queue.maxDiskSpace="{{ rsyslog_queue_maxdisk }}")
```

Per-host var `onelog_role=mail|hosting` để tương lai branch nếu cần — nay chưa dùng (YAGNI).

---

## 6. `ansible.cfg`

```ini
[defaults]
inventory = inventory.ini
host_key_checking = False
retry_files_enabled = False
forks = 20
gathering = smart
fact_caching = jsonfile
fact_caching_connection = /tmp/ansible-facts
fact_caching_timeout = 86400

[ssh_connection]
pipelining = True
ssh_args = -o ControlMaster=auto -o ControlPersist=60s
```

Pipelining + ControlPersist → setup 200 srv từ ~30 phút xuống ~5-10 phút.

---

## 7. Verify post-rollout

Trên logserver:
```bash
curl -s 'http://localhost:9428/select/logsql/query' \
  --data-urlencode 'query=onelog-ansible | stats by (host) count()' \
  --data-urlencode 'start=5m' | jq -r '.[].host' | sort -u | wc -l
```

So với inventory count → host miss thì `--limit <host>` rerun.

---

## 8. So sánh approach

| Approach | Verdict | Lý do |
|---|---|---|
| A. Native Ansible tasks | ✅ Recommended | Idempotent, check mode, diff, per-host template, validate trước commit |
| B. Wrap setup-rsyslog-client.sh qua shell | ❌ Skip | Mất idempotency + diff, shell stdout-based change detection mong manh |
| C. Full role + collection | ❌ Skip | Over-engineered, "Ansible cơ bản" sẽ khó maintain |

---

## 9. Risk & mitigation

| Risk | Mitigation |
|---|---|
| 200 srv × apt update spike mirror | `cache_valid_time=3600` + `--forks 20` |
| Sudo password khác nhau giữa srv | Hiện assume cùng → `--ask-become-pass`. Nếu khác → ansible-vault per-host `ansible_become_password` |
| Batch 50 spike VL disk | Đã có alert disk P0 must-fix #4. Soak 24h giữa batch |
| 1 srv fail giữa batch | `max_fail_percentage: 10` cho phép tiếp tục, retry file rerun |
| Drift sau human edit `/etc/rsyslog.d/` | Cron weekly `--check` để detect; idempotent re-run safe |
| Firewall egress chặn 6514 client→logserver | Pre-check task: `wait_for port` fail sớm thay vì log đen lặng |

---

## 10. Success criteria

- Canary: 1 srv < 2 phút setup, smoke log landed VL < 10s.
- Batch 10: 10 srv < 5 phút, 10/10 verified.
- Batch 200: < 15 phút tổng, ≥ 95% success, retry ≤ 10 host.
- `--check` re-run trên srv đã setup = 0 change (idempotent verified).

---

## 11. Tích hợp với production readiness P0/P1/P2 (report 260625-1553)

- Ansible thuộc **P2 enabler** — cần xong P0 (5 must-fix logserver) trước khi onboard batch lớn.
- Canary chạy được ngay khi P0 done (1 srv pilot = P1 trong report kia).
- Batch 50/200 chỉ chạy sau khi capacity benchmark P1 #8 confirm single-node chịu được, hoặc HA migration §2-§4 ha-roadmap đã start.

---

## 12. Dependencies & next steps

**Pre-req:**
- P0 must-fix #1-5 done (backup offsite, monitor, PII redact, retention, disable mock-logs).
- Inventory data: list IP + hostname + sudo user của 200 srv (CMDB hoặc gom tay).
- Quyết định control node = logserver hay VM riêng.

**Next:**
- Tạo `infra/ansible/` skeleton (4 file, ~150 dòng).
- Canary 1 srv → soak 24h.
- Iterate template/playbook nếu mail/hosting có log path đặc biệt.

---

## Unresolved questions

1. Control node = logserver luôn hay VM riêng? (Logserver tiện nhưng coupling cao)
2. Sudo password giống nhau trên 200 srv? Nếu khác → cần Vault per-host.
3. Có CMDB / list IP-hostname sẵn, hay gom tay 200 dòng inventory?
4. Mail vs hosting srv có khác `ansible_user`?
5. Firewall egress client → logserver 6514 đã mở chưa, hay phải pre-task `ufw allow out`?
6. Có muốn ship Ansible vào repo onelog (`infra/ansible/`) hay tách repo ops riêng?
7. Sau onboard có chạy cron `--check` weekly để detect drift không?
