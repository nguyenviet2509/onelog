#!/usr/bin/env bash
# Generate MCP Bearer tokens for a list of ops engineers.
# Output is the MCP_BEARER_TOKENS= line you paste into .env.
#
# Usage:
#   ./gen-mcp-tokens.sh alice bob carol dave eve
#
# Each user gets a 256-bit random token prefixed `sk-mcp-` so it's grep-friendly
# in audit logs. Rotation = re-run + restart mcp-semantic + mcp-vl containers.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <user1> [user2 ...]" >&2
  exit 2
fi

# Prefer openssl (cross-platform, deterministic CLI flags) and fall back to /dev/urandom
# for hosts without it.
random_token() {
  if command -v openssl >/dev/null 2>&1; then
    echo "sk-mcp-$(openssl rand -hex 32)"
  else
    echo "sk-mcp-$(head -c 32 /dev/urandom | xxd -p -c 64)"
  fi
}

entries=()
for user in "$@"; do
  # Reject characters that would corrupt the env-list parser (`,` and `:`).
  if [[ "$user" == *,* || "$user" == *:* ]]; then
    echo "error: user '$user' contains forbidden char (, or :)" >&2
    exit 2
  fi
  token="$(random_token)"
  entries+=("${user}:${token}")
done

# Print env line + a per-user table for handing tokens out securely.
IFS=','
echo "MCP_BEARER_TOKENS=${entries[*]}"
unset IFS

echo
echo "# Distribute privately (paste into each ops engineer's claude_desktop_config.json):"
for entry in "${entries[@]}"; do
  user="${entry%%:*}"
  token="${entry#*:}"
  printf "  %-12s  %s\n" "$user" "$token"
done
