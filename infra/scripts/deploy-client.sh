#!/usr/bin/env bash
# Deploy onelog rsyslog forwarder onto prod client hosts từ log server.
#
# Usage:
#   bash deploy-client.sh HOST [HOST ...] [--user USER] [--log-server-ip IP] [--dry-run]
#
# Defaults:
#   --user            = $USER
#   --log-server-ip   = auto-detect (hostname -I | first token)
#
# Auth:
#   Password auth supported qua SSH ControlMaster (multiplex) — password hỏi
#   1 lần/host, reuse cho scp + ssh sudo subsequent. Cần sshpass? KHÔNG —
#   OpenSSH ControlMaster socket cache authenticated session ~5 phút.
#
# Prereqs (recommended, one-time per host):
#   ssh-copy-id <user>@<host>            # passwordless — nhanh hơn nhiều
#   Sudo NOPASSWD (optional) — nếu chưa → prompt sudo password remote 1 lần/host
#
# Chỉ install rsyslog forwarding (production). KHÔNG chạm mock-logs — mock
# chỉ cho lab/staging, deploy riêng qua setup-mock-logs.sh nếu cần.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_SCRIPT="$SCRIPT_DIR/setup-rsyslog-client.sh"

USER_NAME="$USER"
LOG_SERVER_IP=""
DRY_RUN=0
HOSTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)             USER_NAME="$2"; shift 2 ;;
    --log-server-ip)    LOG_SERVER_IP="$2"; shift 2 ;;
    --dry-run)          DRY_RUN=1; shift ;;
    -h|--help)          sed -n '2,20p' "$0"; exit 0 ;;
    -*)                 echo "Unknown flag: $1" >&2; exit 2 ;;
    *)                  HOSTS+=("$1"); shift ;;
  esac
done

[[ ${#HOSTS[@]} -eq 0 ]] && { echo "Need ≥1 HOST. See --help." >&2; exit 2; }
[[ -f "$SETUP_SCRIPT" ]] || { echo "Missing $SETUP_SCRIPT" >&2; exit 2; }

if [[ -z "$LOG_SERVER_IP" ]]; then
  LOG_SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -z "$LOG_SERVER_IP" ]] && { echo "Cannot auto-detect LOG_SERVER_IP. Pass --log-server-ip." >&2; exit 2; }
fi

echo "Deploy plan:"
echo "  LOG_SERVER_IP = $LOG_SERVER_IP"
echo "  USER          = $USER_NAME"
echo "  HOSTS         = ${HOSTS[*]}"
[[ $DRY_RUN -eq 1 ]] && echo "  (DRY-RUN — commands sẽ echo, không exec)"
echo

# SSH multiplex: password prompt 1 lần/host, reuse cho scp + subsequent ssh.
# Socket path unique per host, TTL 5 phút.
SSH_CTL_DIR="${TMPDIR:-/tmp}/onelog-ssh-ctl-$$"
mkdir -p "$SSH_CTL_DIR"
trap 'rm -rf "$SSH_CTL_DIR"' EXIT

SSH_OPTS=(
  -o ControlMaster=auto
  -o "ControlPath=$SSH_CTL_DIR/%r@%h:%p"
  -o ControlPersist=5m
  -o ConnectTimeout=10
)

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

OK_COUNT=0
FAIL_HOSTS=()

for HOST in "${HOSTS[@]}"; do
  TARGET="$USER_NAME@$HOST"
  echo "==> Deploying to $HOST ($TARGET)"

  # [1/5] SSH reachable — open master connection (prompt password nếu chưa có key).
  # Không dùng BatchMode để cho phép password auth. -N -f = background master.
  echo "    [1/5] Opening SSH connection (nhập password nếu prompt)..."
  if ! ssh "${SSH_OPTS[@]}" "$TARGET" true; then
    echo "    [1/5] SSH failed ✗ (unreachable / wrong password / host key)"
    FAIL_HOSTS+=("$HOST")
    echo "    ❌ SKIPPED"; echo
    continue
  fi
  echo "    [1/5] SSH reachable ✓ (master session cached ~5m)"

  # Resolve client's actual hostname — VL lưu `host` theo `hostname` output của
  # client, không phải target SSH ($HOST có thể là IP/FQDN). Verify step cần
  # giá trị này để query đúng.
  REMOTE_HOSTNAME="$(ssh "${SSH_OPTS[@]}" "$TARGET" hostname 2>/dev/null || echo "$HOST")"
  [[ "$REMOTE_HOSTNAME" != "$HOST" ]] && echo "        (client hostname: $REMOTE_HOSTNAME)"

  # [2/5] Push setup script (reuse master, không hỏi password nữa)
  run ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p /tmp/onelog-deploy"
  run scp -q -o "ControlPath=$SSH_CTL_DIR/%r@%h:%p" "$SETUP_SCRIPT" "$TARGET:/tmp/onelog-deploy/setup-rsyslog-client.sh"
  echo "    [2/5] Files pushed ✓"

  # [3/5] Remote setup (sudo với -t để prompt sudo password remote nếu cần)
  if ! run ssh -t "${SSH_OPTS[@]}" "$TARGET" "sudo LOG_SERVER_IP=$LOG_SERVER_IP bash /tmp/onelog-deploy/setup-rsyslog-client.sh"; then
    echo "    [3/5] setup-rsyslog-client.sh FAILED"
    FAIL_HOSTS+=("$HOST")
    echo "    ❌ ABORTED"; echo
    continue
  fi
  echo "    [3/5] setup-rsyslog-client.sh executed ✓"

  # [4/5] Cleanup
  run ssh "${SSH_OPTS[@]}" "$TARGET" "rm -rf /tmp/onelog-deploy"
  echo "    [4/5] Cleanup ✓"

  # [5/5] Verify VL received log từ host (retry 3× × 10s = 30s tổng)
  if [[ $DRY_RUN -eq 0 ]]; then
    VL_URL="http://localhost:9428/select/logsql/query"
    FOUND=0
    for i in 1 2 3; do
      sleep 10
      COUNT=$(curl -fsS -m 5 --data-urlencode "query=host:$REMOTE_HOSTNAME AND service:client-onboard" \
                --data-urlencode "limit=1" "$VL_URL" 2>/dev/null | wc -l || echo 0)
      if [[ "${COUNT:-0}" -ge 1 ]]; then FOUND=1; break; fi
    done
    if [[ $FOUND -eq 1 ]]; then
      echo "    [5/5] VL received log from $REMOTE_HOSTNAME ✓"
      OK_COUNT=$((OK_COUNT+1))
      echo "    ✅ DONE"
    else
      echo "    [5/5] VL không nhận log từ '$REMOTE_HOSTNAME' sau 30s ✗"
      echo "        Check: UFW logserver allow 6514/tcp, client rsyslog ESTAB"
      FAIL_HOSTS+=("$HOST")
      echo "    ❌ VERIFY FAILED"
    fi
  else
    echo "    [5/5] (dry-run — skip VL verify)"
    OK_COUNT=$((OK_COUNT+1))
  fi
  echo
done

echo "==> Summary: $OK_COUNT OK, ${#FAIL_HOSTS[@]} failed"
[[ ${#FAIL_HOSTS[@]} -gt 0 ]] && echo "    Failed: ${FAIL_HOSTS[*]}"
exit "${#FAIL_HOSTS[@]}"
