#!/usr/bin/env bash
# issue-client-certs.sh — batch-issue rsyslog mTLS client certs for the fleet.
#
# Reads host names from Ansible inventory (or first positional arg = comma-list)
# and writes {host}.crt / {host}.key / ca.crt into infra/ansible/tls-certs/.
# That directory is the source dir consumed by roles/onelog-client/tasks/tls.yml.
#
# Prereqs (one-time):
#   1. `docker compose --profile tls up -d step-ca`
#   2. Bootstrap the step CLI on this host:
#        step ca bootstrap --ca-url https://localhost:9000 \
#          --fingerprint $(docker exec ragstack-step-ca step certificate fingerprint /home/step/certs/root_ca.crt)
#   3. Export CA password so `step ca certificate` non-interactive:
#        export STEP_CA_PASSWORD_FILE=/path/to/ca-password
#
# Usage:
#   bash issue-client-certs.sh                        # read from ansible inventory
#   bash issue-client-certs.sh web-01,web-02,db-01    # explicit list
#   bash issue-client-certs.sh --renew                # renew all existing certs
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${INFRA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ANSIBLE_DIR="$INFRA_DIR/ansible"
CERT_DIR="$ANSIBLE_DIR/tls-certs"
INVENTORY="${ANSIBLE_INVENTORY:-$ANSIBLE_DIR/inventory.ini}"
RENEW=0
HOSTS_ARG=""

for arg in "$@"; do
  case "$arg" in
    --renew) RENEW=1 ;;
    *)       HOSTS_ARG="$arg" ;;
  esac
done

command -v step >/dev/null || { echo "step CLI missing — install: https://smallstep.com/docs/step-cli/installation" >&2; exit 2; }

mkdir -p "$CERT_DIR"
chmod 0750 "$CERT_DIR"

# Emit CA cert once (idempotent). Sourced from bootstrapped ~/.step store.
if [[ ! -f "$CERT_DIR/ca.crt" ]]; then
  step certificate inspect --format json "$HOME/.step/certs/root_ca.crt" >/dev/null
  cp "$HOME/.step/certs/root_ca.crt" "$CERT_DIR/ca.crt"
fi

# Resolve host list.
if [[ -n "$HOSTS_ARG" ]]; then
  HOSTS="${HOSTS_ARG//,/ }"
else
  [[ -f "$INVENTORY" ]] || { echo "Missing inventory: $INVENTORY (or pass hosts as arg)" >&2; exit 2; }
  # Extract host aliases: lines that look like `hostname ansible_host=...`
  HOSTS=$(grep -E '^[a-zA-Z0-9][a-zA-Z0-9._-]*\s' "$INVENTORY" | awk '{print $1}' | sort -u)
fi

for HOST in $HOSTS; do
  CERT="$CERT_DIR/$HOST.crt"
  KEY="$CERT_DIR/$HOST.key"
  if [[ -f "$CERT" && $RENEW -eq 0 ]]; then
    echo "skip $HOST (cert exists — pass --renew to rotate)"
    continue
  fi
  echo "issue $HOST"
  step ca certificate "$HOST" "$CERT" "$KEY" \
    --provisioner "${STEPCA_PROVISIONER:-onelog-ops}" \
    --san "$HOST" \
    --not-after 8760h \
    --force
  chmod 0400 "$KEY"
done

echo
echo "Certs in: $CERT_DIR"
echo "Next: ansible-playbook -i inventory.ini deploy-clients.yml -e enable_tls=true"
