# Deployment — Prod client rsyslog forwarder

Deploy 1 client vào onelog pipeline = **1 lệnh chạy từ log server**.

## Golden rules

1. **Chạy từ log server**, không từ máy dev — script tự detect `LOG_SERVER_IP` bằng `hostname -I`.
2. **Prod client KHÔNG install mock-logs** — mock riêng cho lab (`setup-mock-logs.sh`).
3. **SSH key phải setup trước** — script fail-fast nếu không passwordless.
4. **Verify tự động** — script query VictoriaLogs sau deploy, fail nếu 0 log trong 30s.

## Quick deploy

```bash
# Trên log server
cd ~/onelog/infra
bash scripts/deploy-client.sh srv-05 srv-06 srv-07
# hoặc IP: bash scripts/deploy-client.sh 192.168.122.55
# hoặc FQDN: bash scripts/deploy-client.sh srv-05.lab.internal
```

HOST arg chấp nhận hostname / IP / FQDN — bất kỳ format `ssh` accept. Script tự query `hostname` remote để verify VL đúng field `host:` (VL lưu theo `hostname` client, không phải target SSH).

Output:
```
==> Deploying to srv-05 (vietnt@srv-05)
    [1/5] SSH reachable ✓
    [2/5] Files pushed ✓
    [3/5] setup-rsyslog-client.sh executed ✓
    [4/5] Cleanup ✓
    [5/5] VL received log from srv-05 ✓
    ✅ DONE
```

## Auth workflow

Script hỗ trợ **password auth** qua SSH ControlMaster:
- Password SSH hỏi **1 lần/host** ở step [1/5], socket cache 5 phút → scp + subsequent ssh trong cùng script không hỏi lại.
- Sudo password remote (step [3/5]) hỏi thêm 1 lần nếu client chưa NOPASSWD.

Tổng cộng: **≤2 password prompts/host** (SSH + sudo remote).

### Khuyến nghị (one-time per host, giảm còn 0 prompt)

```bash
# 1. Passwordless SSH
ssh-copy-id vietnt@srv-XX

# 2. Sudo NOPASSWD trên client (ssh vào chạy 1 lần)
echo "vietnt ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/vietnt-nopasswd
```

Sau 2 bước trên → deploy-client.sh chạy hoàn toàn im lặng, phù hợp CI.

## Flags

| Flag | Default | Mô tả |
|---|---|---|
| `--user USER` | `$USER` | SSH user trên client |
| `--log-server-ip IP` | auto (`hostname -I`) | Override khi log server có nhiều IP |
| `--dry-run` | off | Echo commands, không exec |

## Verify checklist (sau khi script báo ✅)

```bash
# Trên log server
curl -s "http://localhost:9428/select/logsql/query" \
  --data-urlencode "query=host:srv-XX" --data-urlencode "limit=5"

# Xem stream/service breakdown
curl -s "http://localhost:9428/select/logsql/hits?query=host:srv-XX&field=service"
```

Trên client:
```bash
ss -tnp | grep ':6514'                       # phải có ESTAB tới log server
sudo systemctl status rsyslog                 # active (running)
sudo tail -f /var/log/syslog | grep -i onelog # không có warn/error
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `[1/5] SSH reachable ✗` | `ssh-copy-id vietnt@$HOST`. Test: `ssh -o BatchMode=yes vietnt@$HOST true` |
| `[3/5] setup FAILED` | ssh vào client, chạy `sudo bash /tmp/onelog-deploy/setup-rsyslog-client.sh` xem log |
| `[5/5] VL không nhận log` | (a) UFW log server: `ufw status \| grep 6514` — allow từ client CIDR; (b) client `ss -tnp \| grep 6514` — không ESTAB → target IP sai hoặc firewall chặn |
| Sudo prompt lặp lại | Config NOPASSWD cho user deploy trên client: `echo "vietnt ALL=(ALL) NOPASSWD:ALL" \| sudo tee /etc/sudoers.d/vietnt-nopasswd` |
| Auto-detect LOG_SERVER_IP sai (multi-NIC) | Pass `--log-server-ip 192.168.122.53` explicit |

## Rollback

```bash
# Trên client
sudo mv /etc/rsyslog.d/90-forward-onelog.conf{,.disabled}
sudo systemctl restart rsyslog
```

## Update flow (khi sửa setup-rsyslog-client.sh)

```bash
# Trên log server
cd ~/onelog && git pull
bash infra/scripts/deploy-client.sh srv-05 srv-06   # re-run, idempotent
```

Script mới tự backup conf cũ (`.bak`), ghi conf mới, restart rsyslog.

## Unresolved

- Chưa support batch config-only reload (chỉ update conf, không install lại rsyslog). Nếu cần, thêm flag `--config-only` sau.
- Chưa có script tương tự để bootstrap log server end-to-end (`bootstrap-log-server.sh`) — đang track riêng ở brainstorm Hướng A.
