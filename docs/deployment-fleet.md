# Fleet rollout — Ansible playbook (50-100 clients)

Batch-deploys the rsyslog forwarder to a whole fleet. Replaces manual per-host
`deploy-client.sh` runs once the fleet grows past a handful of servers.

Location: [infra/ansible/](../infra/ansible/)

## Golden rules

- Inventory is the single source of truth for which hosts forward logs. Version it in git (separate private repo if it contains internal IPs).
- Always `--check` before real run when you touch the template or role tasks.
- Rolling wave `serial: "20%"` in `deploy-clients.yml` — if the config breaks rsyslog, only 1/5 of the fleet takes the hit.
- Do NOT commit `inventory.ini` (real hosts) — only `inventory.example.ini`.

## Prereqs

- Control node: Ansible ≥ 2.14 (`sudo apt install ansible` or `pipx install ansible`).
- SSH: `ssh-copy-id ops@<host>` for every host (or use `--ask-pass`).
- Sudo: NOPASSWD preferred; else add `--ask-become-pass`.
- Control node must reach VictoriaLogs at `http://<log_server_ip>:9428/` (verify step).
- Log server firewall: `ufw allow 6514/tcp` from client CIDR.

## Quick deploy

```bash
cd infra/ansible
cp inventory.example.ini inventory.ini
# edit inventory.ini — add hosts, set log_server_ip

# 1. Ping check (SSH + sudo reachability)
ansible onelog_clients -m ping

# 2. Dry-run (shows diff, no changes)
ansible-playbook deploy-clients.yml --check --diff

# 3. Real run — rolls out 20% at a time, fails-fast per host
ansible-playbook deploy-clients.yml

# Subset:
ansible-playbook deploy-clients.yml -l web
ansible-playbook deploy-clients.yml -l 'web-01,db-01'

# Override log server on the fly:
ansible-playbook deploy-clients.yml -e log_server_ip=10.0.0.5
```

## What it does per host

1. `apt install rsyslog` if missing, enable service.
2. Backup any conflicting `/etc/rsyslog.d/*-forward*.conf` to `.bak`.
3. Drop `/etc/rsyslog.d/90-forward-onelog.conf` from Jinja template (TCP 6514, RFC5424, disk-backed queue 500 MB).
4. `rsyslogd -N1 -f` validates syntax BEFORE the file lands (Ansible `validate:` hook — aborts if broken).
5. Restart rsyslog only if config changed (handler-triggered — idempotent).
6. `logger -t client-onboard` fires smoke log.
7. Control node queries VL `host:<hostname> AND service:client-onboard` — retries 6 × 5 s = 30 s. Fails host on empty.

## Config knobs

Set in `inventory.ini` under `[onelog_clients:vars]` or pass with `-e`:

| Var | Default | Purpose |
|-----|---------|---------|
| `log_server_ip` | `192.168.122.53` | Target syslog server. |
| `log_server_port` | `6514` | TCP port (change if you enable TLS on 6515). |
| `vl_query_url` | `http://{{ log_server_ip }}:9428/select/logsql/query` | Where control node verifies ingest. |
| `ansible_user` | `ops` | SSH user with sudo. |

## Adding a new host

1. Append host line under the appropriate group in `inventory.ini`.
2. `ssh-copy-id ops@newhost`.
3. `ansible-playbook deploy-clients.yml -l newhost`.
4. Confirm on log server: `curl 'http://localhost:9428/select/logsql/query?query=host:newhost&limit=5'`.

## Removing a host

Playbook does not uninstall. To decommission:

```bash
ansible newhost -b -m file -a "path=/etc/rsyslog.d/90-forward-onelog.conf state=absent"
ansible newhost -b -m service -a "name=rsyslog state=restarted"
# then remove line from inventory.ini
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `verify.yml` fails — VL empty | UFW blocking 6514/tcp on log server, or client can't reach LOG_SERVER_IP | `sudo ufw allow from <client_cidr> to any port 6514 proto tcp`; test `nc -zv <log_server_ip> 6514` from client |
| `rsyslogd -N1` validation error | Template drift after edit | Run `--check --diff` before real deploy; test on 1 host with `-l host-01` |
| Handler didn't restart rsyslog | Config identical (no change) | Expected — Ansible only restarts on real diff |
| Some hosts fail, playbook halts | `serial: "20%"` wave hit `any_errors_fatal: false` — playbook continues | Check failed hosts in summary; re-run with `-l failed_host_1,failed_host_2` |
| Duplicate logs after rollout | Legacy forwarder still active | Playbook backs up to `.bak`; verify `ls /etc/rsyslog.d/*.conf*` on host |

## Rollback

Revert host to pre-OneLog state:

```bash
ansible <host> -b -m shell -a "mv /etc/rsyslog.d/90-forward-onelog.conf /etc/rsyslog.d/90-forward-onelog.conf.disabled && systemctl restart rsyslog"
# If a legacy config was backed up:
ansible <host> -b -m shell -a "ls /etc/rsyslog.d/*.bak && for f in /etc/rsyslog.d/*.bak; do mv \$f \${f%.bak}; done && systemctl restart rsyslog"
```

## Unresolved

- Client-side mTLS still on 6514 plain-TCP — TLS variant (port 6515 + client cert) tracked in Tier-2 improvements, needs CA infra first.
- No `onelog-agent` component yet (host metrics, disk probes) — Ansible role only ships log forwarder. Extend `roles/onelog-client/` when telemetry agent lands.
