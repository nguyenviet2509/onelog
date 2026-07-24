#!/bin/sh
# Idempotent apply of policy routing for eth1 (10.200.0.30)
# CONNMARK-based so it survives docker DNAT reload.
# Called by eth1-policy-routing.service (on boot) and eth1-policy-routing.timer (every 5 min).
set -e

IFACE=eth1
PRIV_IP=10.200.0.30
PRIV_GW=10.200.0.1
TABLE=200

# Route table 200: default via priv gateway
/sbin/ip route replace default via "$PRIV_GW" dev "$IFACE" table "$TABLE"

# Mark NEW conntracks arriving on eth1
/sbin/iptables -t mangle -C PREROUTING -i "$IFACE" -m conntrack --ctstate NEW -j CONNMARK --set-mark 1 2>/dev/null \
  || /sbin/iptables -t mangle -A PREROUTING -i "$IFACE" -m conntrack --ctstate NEW -j CONNMARK --set-mark 1

# Restore mark on subsequent packets (PREROUTING + OUTPUT so replies pick it up)
/sbin/iptables -t mangle -C PREROUTING -j CONNMARK --restore-mark 2>/dev/null \
  || /sbin/iptables -t mangle -A PREROUTING -j CONNMARK --restore-mark
/sbin/iptables -t mangle -C OUTPUT -j CONNMARK --restore-mark 2>/dev/null \
  || /sbin/iptables -t mangle -A OUTPUT -j CONNMARK --restore-mark

# ip rules: fwmark 1 → table 200 (with suppress_prefixlength 0 so local routes still match first)
/sbin/ip rule add fwmark 1 lookup main suppress_prefixlength 0 priority 89 2>/dev/null || true
/sbin/ip rule add fwmark 1 lookup 200 priority 90 2>/dev/null || true
# Source-based rules for locally originated traffic from priv IP
/sbin/ip rule add from "$PRIV_IP" lookup main suppress_prefixlength 0 priority 100 2>/dev/null || true
/sbin/ip rule add from "$PRIV_IP" lookup 200 priority 101 2>/dev/null || true

/sbin/ip route flush cache
