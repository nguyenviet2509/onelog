---
type: brainstorm
date: 2026-08-02
slug: ddos-visibility
status: approved
---

# DDoS Visibility trong OneLog — Brainstorm Summary

## Problem
ClientServer bị DDoS → hiện tại OneLog **không có evidence attack** trong VictoriaLogs, **không có alert Telegram**. Chỉ thấy hậu quả downstream (OOM, service crash) sau khi đã trễ.

## Current state (scout)
| Layer | Status |
|---|---|
| Syslog kernel/systemd | ✓ vào VLogs |
| HTTP access log (OLS/Nginx) | ✗ chưa wire |
| HTTP status codes 429/5xx aggregation | ✗ chưa có rule |
| L4 TCP metrics (SYN_RECV, drops, conntrack) | ✗ chưa scrape |
| Telegram alert cho DDoS | ✗ receiver có, rule không |

Rule hiện tại tangentially liên quan: `OomKillEvent`, `WebServerErrorBurst` (generic), `SystemdServiceFailed`, `RsyslogRateLimitDrop` — đều fire **sau** khi đã sập.

## Approaches đánh giá

### A — L7 HTTP-based
Wire access log OLS/Nginx qua rsyslog imfile → Vector VRL parse → VLogs.
- Pros: bắt request flood, có source IP, dùng pipeline có sẵn
- Cons: log volume lớn, cần sampling

### B — L4 kernel/TCP metrics
node_exporter netstat/sockstat/tcpstat → VictoriaMetrics.
- Pros: nhẹ, bắt SYN flood non-HTTP, low cardinality
- Cons: cần node_exporter đồng loạt, không có source IP L7

### C — A+B defense-in-depth ✅ CHỌN
L7 bắt request pattern, L4 bắt volumetric. Cross-signal cho phép severity `critical` khi cả 2 fire trong 5m → giảm false positive.

## Solution

### Architecture
```
ClientServer                       Central OneLog
[OLS/Nginx access.log] ─rsyslog imfile─▶ Vector :6514 ─▶ VictoriaLogs
[node_exporter netstat] ─scrape──────▶ VictoriaMetrics
                                            │
                                            ▼
                                    vmalert rules ─▶ Alertmanager ─▶ Telegram
```

### New rules
| Rule | Layer | Condition | Severity |
|---|---|---|---|
| `HttpRateLimit429Burst` | L7 | count(http_status:429) > 100/2m | warning |
| `HttpServerErrorSpike` | L7 | count(http_status:5xx) > 200/2m | warning |
| `HttpTopAttackerIP` | L7 | top-K remote_addr > 500 req/1m | warning + IP label |
| `TcpSynRecvHigh` | L4 | node_netstat_Tcp_CurrEstab spike vs 1h baseline | warning |
| `TcpBacklogDropRising` | L4 | rate(node_netstat_TcpExt_TCPBacklogDrop[5m]) > 10 | warning |
| `ConntrackNearFull` | L4 | conntrack_entries / max > 0.8 | critical |
| `DdosCorrelated` | Meta | L7 + L4 rule cùng fire trong 5m | critical → Telegram priority |

### Alertmanager routing
- Group label `category=ddos` → Telegram receiver hiện có
- Critical → escalation channel (nếu có)

### Sampling & volume control
- Access log 2xx: sample 10%
- 4xx/5xx: giữ 100%
- Retention VLogs cho `service=nginx|ols`: 14 ngày

## Unresolved / cần scout ở phase plan
1. node_exporter đã deploy trên ClientServer fleet chưa? (nếu chưa → thêm phase deploy)
2. Số lượng ClientServer + baseline traffic → estimate log volume + threshold
3. Access log format hiện tại của OLS/Nginx (default hay custom)?
4. Baseline "traffic bình thường" để set threshold không phải static
5. Có escalation channel Telegram thứ 2 cho `critical` không?

## Success criteria
- DDoS simulation (hping3/slowloris) → alert Telegram fire trong ≤2 phút
- Access log 429/5xx query được trên VLogs với structured field
- L4 metric graph SYN_RECV, conntrack visible trên Grafana
- False positive rate ≤1 alert/tuần trong 2 tuần đầu

## Next
`/ck:plan` với context ref = báo cáo này.
