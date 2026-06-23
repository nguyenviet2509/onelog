#!/usr/bin/env bash
# Install + enable onelog mock log generator on a client server.
#
# Prereqs:
#   - rsyslog already forwarding to onelog logserver (see setup-rsyslog-client.sh)
#   - mock-logs.py + mock-logs.service copied into same dir as this script, OR
#     present at /tmp/mock-logs.{py,service}
#
# Usage (after scp the 3 files to /tmp on the client):
#   sudo bash /tmp/setup-mock-logs.sh
#
# Tune rate after deploy:
#   sudo systemctl edit mock-logs           # override Environment=MOCK_RATE=50
#   sudo systemctl restart mock-logs
#
# Disable when real logs arrive:
#   sudo systemctl disable --now mock-logs
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
PY_SRC=""
UNIT_SRC=""
for cand in "$SRC_DIR/mock-logs.py" "$SRC_DIR/../clients/mock-logs.py" "/tmp/mock-logs.py"; do
  [[ -f "$cand" ]] && PY_SRC="$cand" && break
done
for cand in "$SRC_DIR/mock-logs.service" "$SRC_DIR/../clients/mock-logs.service" "/tmp/mock-logs.service"; do
  [[ -f "$cand" ]] && UNIT_SRC="$cand" && break
done

if [[ -z "$PY_SRC" || -z "$UNIT_SRC" ]]; then
  echo "Cannot find mock-logs.py or mock-logs.service nearby; scp them to /tmp first." >&2
  exit 2
fi

# ---------- [1/4] Sanity check rsyslog ----------
echo "[1/4] Verify rsyslog is forwarding"
if ! systemctl is-active --quiet rsyslog; then
  echo "  ✗ rsyslog not active. Run setup-rsyslog-client.sh first." >&2
  exit 3
fi
if ! ss -tn 2>/dev/null | grep -qE ':6514\s+ESTAB'; then
  echo "  ⚠️  No ESTAB connection on :6514 — logs may queue locally until logserver reachable."
fi

# ---------- [2/4] Install files ----------
echo "[2/4] Install /usr/local/bin/mock-logs.py + unit"
install -m 0755 "$PY_SRC" /usr/local/bin/mock-logs.py
install -m 0644 "$UNIT_SRC" /etc/systemd/system/mock-logs.service

# ---------- [3/4] Enable + start ----------
echo "[3/4] Enable mock-logs.service"
systemctl daemon-reload
systemctl enable --now mock-logs.service
sleep 2

# ---------- [4/4] Verify ----------
echo "[4/4] Verify"
if systemctl is-active --quiet mock-logs; then
  echo "  ✓ mock-logs active on $(hostname)"
  journalctl -u mock-logs -n 3 --no-pager || true
else
  echo "  ✗ mock-logs failed to start"
  journalctl -u mock-logs -n 20 --no-pager
  exit 4
fi

echo
echo "Verify on logserver (replace IP):"
echo "  curl 'http://<LOGSERVER>:9428/select/logsql/query?query=service:~\"mock-.*\"+AND+host:\"$(hostname)\"&limit=5'"
echo
echo "Scale rate:  sudo systemctl edit mock-logs  → Environment=MOCK_RATE=50 → restart"
echo "Disable:     sudo systemctl disable --now mock-logs"
