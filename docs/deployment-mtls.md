# mTLS syslog transport

Two-phase rollout hardening rsyslog forwarders from plaintext TCP 6514 to mutual-TLS TCP 6516. Uses **step-ca** as the internal CA (opt-in container in [docker-compose.yml](../infra/docker-compose.yml)).

Components:
- [step-ca](../infra/docker-compose.yml) service — profile `tls`.
- [issue-client-certs.sh](../infra/scripts/issue-client-certs.sh) — batch cert issuance.
- Ansible role [onelog-client](../infra/ansible/roles/onelog-client/) — `enable_tls=true` provisions cert + rewrites rsyslog config.
- Vector TLS listener block — commented in [vector.yaml](../infra/vector/vector.yaml), enable when certs staged.

## Golden rules

- **Bootstrap CA once**. `./data/step-ca/` is authoritative. Do NOT `docker compose down -v` on the tls profile once clients are issued — you lose the root and every client cert is orphaned.
- Keep the CA password in a **chmod 0400** file, NOT in `.env` alongside app secrets. CA compromise = every client compromised.
- Renew before expiry. Default `--not-after 8760h` (1 year). Set a cron reminder at 10 months.
- Run TLS **alongside** plain 6514 during migration. Cut over 1 group at a time. Retire 6514 only after 100% of hosts move.

## Phase 0 — Bootstrap CA (one-time)

```bash
cd infra
# 1. Create CA password file BEFORE first `up` (init reads it once, then treats
# ./data/step-ca as authoritative). Keep this file — required for future ops.
mkdir -p data/step-ca/secrets
openssl rand -base64 32 > data/step-ca/secrets/password
chmod 0400 data/step-ca/secrets/password

# 2. Bring up step-ca (init runs once on empty volume).
docker compose --profile tls up -d step-ca
docker logs -f ragstack-step-ca            # watch for "Init complete"

# 3. Grab the CA fingerprint (needed for bootstrap on clients that use step CLI).
FINGERPRINT=$(docker exec ragstack-step-ca step certificate fingerprint /home/step/certs/root_ca.crt)
echo "$FINGERPRINT"

# 4. Install step CLI on log-server host (Ansible control node).
#    https://smallstep.com/docs/step-cli/installation
step ca bootstrap --ca-url https://localhost:9000 --fingerprint "$FINGERPRINT"
export STEP_CA_PASSWORD_FILE="$PWD/data/step-ca/secrets/password"
```

## Phase 1 — Issue client certs

```bash
# Reads Ansible inventory, writes certs into infra/ansible/tls-certs/
bash infra/scripts/issue-client-certs.sh

# Or for a subset:
bash infra/scripts/issue-client-certs.sh web-01,web-02

# Verify one:
step certificate inspect infra/ansible/tls-certs/web-01.crt --short
```

Output layout:

```
infra/ansible/tls-certs/
├── ca.crt
├── web-01.crt
├── web-01.key
├── web-02.crt
└── web-02.key
```

`tls-certs/` is gitignored by default — add to `.gitignore` if not already.

## Phase 2 — Enable server-side TLS listener

1. Issue a server cert for Vector:
   ```bash
   step ca certificate log-server.onelog.local \
     infra/vector/certs/server.crt infra/vector/certs/server.key \
     --san log-server.onelog.local --san "$(hostname -I | awk '{print $1}')"
   cp ~/.step/certs/root_ca.crt infra/vector/certs/ca.crt
   chmod 0400 infra/vector/certs/server.key
   ```
2. Uncomment the `syslog_tcp_tls` source in [vector.yaml](../infra/vector/vector.yaml).
3. Expose port 6516 — add to `vector.ports:` in compose:
   ```yaml
   - "6516:6516/tcp"
   ```
4. Firewall: `sudo ufw allow from <client_cidr> to any port 6516 proto tcp`.
5. `docker compose up -d vector`.
6. Smoke test from log-server:
   ```bash
   openssl s_client -connect log-server:6516 -CAfile infra/vector/certs/ca.crt </dev/null | head
   ```

## Phase 3 — Migrate clients (Ansible)

Rolling cutover — test on 1 group first:

```bash
cd infra/ansible

# Test group first
ansible-playbook deploy-clients.yml -l web -e enable_tls=true -e log_server_port=6516

# Verify TLS conn established from client:
ansible web -m shell -a "ss -tnp | grep :6516"

# Full fleet after smoke passes
ansible-playbook deploy-clients.yml -e enable_tls=true -e log_server_port=6516
```

The role's [tls.yml](../infra/ansible/roles/onelog-client/tasks/tls.yml) installs `rsyslog-gnutls`, drops `ca.crt` + per-host `client.crt`/`client.key` into `/etc/rsyslog.d/tls/`, and the Jinja template swaps in the gtls stream driver.

## Phase 4 — Retire plain 6514

After 1-2 weeks of stable TLS operation:

1. Confirm zero traffic on 6514: `ss -tn state established '( sport = :6514 )'` returns nothing.
2. Remove 6514 port from `vector.ports:` in compose.
3. Remove `syslog_tcp:` source in `vector.yaml`.
4. Close firewall: `sudo ufw delete allow 6514/tcp`.

## Renewal

```bash
# All hosts (annual)
bash infra/scripts/issue-client-certs.sh --renew
ansible-playbook deploy-clients.yml -e enable_tls=true

# Single host
bash infra/scripts/issue-client-certs.sh web-01 --renew
ansible-playbook deploy-clients.yml -l web-01 -e enable_tls=true
```

Handler restarts rsyslog only when the cert file actually changed → safe to run on healthy fleet.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `rsyslogd: error connecting to remote host … certificate verify failed` | Client cert doesn't chain to CA installed on Vector | Confirm `/etc/rsyslog.d/tls/ca.crt` on client matches `infra/vector/certs/ca.crt` on server (both = step-ca root) |
| `openssl s_client` shows `no peer certificate available` | Vector `verify_certificate` off | Set `verify_certificate: true` in vector.yaml TLS block |
| `step ca certificate` hangs | Missing password | `export STEP_CA_PASSWORD_FILE=…` before running |
| `x509: certificate has expired` | Client cert older than `--not-after` | Run `issue-client-certs.sh --renew` |
| Cert renew but rsyslog still uses old | Handler didn't fire (file mtime same) | `ansible <host> -b -m service -a "name=rsyslog state=restarted"` |

## Unresolved

- Vault vs step-ca — step-ca fine for ≤500 hosts. Beyond that, evaluate Vault PKI + agent for auto-renewal.
- ACME provisioner — step-ca supports it; can auto-renew via `certbot`-compatible clients. Deferred until manual rotation becomes painful.
- HSM-backed root — production CA should keep root offline / on HSM. Current setup keeps root online in `./data/step-ca` — acceptable for internal fleet, revisit for compliance-sensitive envs.
