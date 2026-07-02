# Brainstorm — OneLog Readiness cho Ops Team vận hành >200 srv + MCP Claude

**Date:** 2026-07-01 14:01 (Asia/Saigon)
**Owner:** trihd@inet.vn
**Question:** OneLog đã đủ để team ops dùng vận hành >200 server logs tập trung + MCP Claude support chưa?

---

## 1. Verdict (thẳng)

**CHƯA ĐỦ cho 200 srv.** Đủ cho **pilot 3-10 srv** sau khi đóng P0. Từ pilot → 200 srv cần thêm 2-3 tháng work (capacity + HA + ops maturity).

Cụ thể:

| Scale | Status | Điều kiện |
|---|---|---|
| 1-3 srv pilot | ⚠️ GO có điều kiện | Fix 5 P0 của brainstorm 260625-1553 (backup offsite, monitoring, PII rules mail/hosting, retention, mock-logs off) |
| 10-30 srv | ⚠️ Conditional | + P1 (runbook 5 incident, token rotation, benchmark, disk queue drill, Drain3 tune) |
| 50-100 srv | ❌ NOT READY | + Prometheus/Grafana thật + capacity benchmark + backup offsite verified + HA prep §4 (indexer scale + Redis Drain3 state) |
| **200+ srv** | ❌ **NOT READY** | + HA roadmap §2 (VL cluster) + §3 (Qdrant cluster) + LLM cost cap + on-call rotation + DR drill |

---

## 2. Đã có (assets)

**Ingest**
- 3 path: UDP 514, TCP 6514 RFC5424, JSON ECS-lite 6515 — cover rsyslog stock + Vector agent
- Vector VRL redact PII (email/ip/JWT) — hardened per journal 2026-06-26
- Ansible client rollout plan (260625-1609) — automate onboarding

**Storage + Query**
- VictoriaLogs single-node, LogsQL query proven trên lab
- Qdrant + Drain3 template indexing → semantic search

**MCP for Claude**
- `mcp-vl` (query/hits/stats_query) + `mcp-semantic` (search_log_templates)
- Bearer token auth qua Caddy forward_auth
- Audit log `/var/log/onelog-audit/mcp-semantic.log`
- Team Project workflow doc (`onelog-team-project-guide.md`) — 5 ops share investigation

**Ops tooling**
- Setup script idempotent + systemd unit + healthcheck + snapshot daily local
- Ops cheatsheet (reload vs force-recreate, per-service commands)
- vmalert + Alertmanager + Telegram (alerts profile)

**Kỷ luật docs**
- Deployment guide, HA roadmap, MCP setup guide, journals đều update — tốt hơn nhiều dự án cùng size

---

## 3. Gap chặn scale 200 srv (P0/P1)

### P0 — chặn go-live pilot (từ brainstorm 260625-1553, vẫn valid)

1. **Backup offsite = 0** → logserver chết = mất hết. Fix: rclone/rsync snapshot → NAS/MinIO nội bộ.
2. **Monitoring runtime = 0** — chỉ có healthcheck on-demand. 200 srv mà không có Grafana = mù. Cần Prometheus scrape `/metrics` vector/indexer/VL + node-exporter + dashboard tối thiểu (ingest rate, indexer lag, disk %, LLM spend).
3. **PII redact chưa test với log thật** mail/hosting (Postfix, Dovecot, cPanel). Sample 1k dòng thật mỗi loại → tune VRL trước khi mở firewall client thật.
4. **Retention VL = forever** → 200 srv × ~2GB/ngày × 30d ≈ 12TB. Phải set `--retentionPeriod` + alert disk 70%.
5. **Mock-logs service** phải verify off trên prod (guard trong setup script).

### P1 — chặn scale ngoài pilot

6. **Runbook 5 incident**: disk full VL, NATS pending lag, Vector restart loop, MCP token compromise, logserver reboot. Ops-cheatsheet có template nhưng thiếu playbook step-by-step per incident.
7. **MCP bearer token rotation + revoke**: hiện 1 token dùng chung. 200 srv scale ops team → cần per-user token, rotate schedule, revoke procedure.
8. **Capacity benchmark thật**: chưa đo được single-node chịu bao nhiêu GB/ngày. Không biết khi nào chạm HA trigger.
9. **Client-side disk queue drill**: tắt logserver 1h, verify rsyslog/Vector resume không mất log.
10. **Drain3 explosion guard**: monitor `unmatched_rate` cho Postfix (log format đa dạng) → Qdrant phình.

### P2 — chặn 200 srv scale-out (per `docs/ha-roadmap.md`)

11. **VL HA (§2)**: 200 srv × 2GB/ngày = ~400GB/ngày, chạm threshold 200GB/ngày → tách vlinsert/vlstorage/vlselect.
12. **Qdrant cluster (§3)**: >50M vector khi 200 srv × Drain3 template = high probability chạm.
13. **Indexer scale (§4)**: single worker ~5k log/s. 200 srv burst × 10× = có thể vượt. Cần NATS cluster + N worker + Drain3 state → Redis.
14. **LLM cost cap**: 5-10 ops query MCP liên tục → chi phí Claude API không kiểm soát. Cần budget per user + cache.
15. **On-call rotation + escalation matrix**: 200 srv = ops team phải có on-call, không phải "owner ops giai đoạn đầu".
16. **DR drill quarterly**: restore từ snapshot vào staging, verify RPO/RTO thực tế.

---

## 4. MCP Claude support — riêng gap

MCP tooling **về technical đủ dùng** cho pilot, nhưng scale team + concurrent usage:

| Aspect | Ready? | Note |
|---|---|---|
| Tool coverage (query, hits, stats, search_log_templates) | ✅ | Đủ 80% use case ops |
| Team Project doc + workflow | ✅ | onelog-team-project-guide.md rõ ràng |
| Bearer auth + audit | ⚠️ | Shared token — cần per-user (P1 #7) |
| Rate limiting per user | ❌ | 5 ops × liên tục = có thể DoS VL/Qdrant, chưa có cap |
| Cache layer (Redis semantic cache) | ❌ | 5 ops hỏi trùng → LLM cost bloat. HA roadmap §5.2 chưa impl |
| Query latency với 200 srv volume | ❓ | Chưa benchmark. VictoriaLogs stats_query trên >TB data có thể chậm |
| MCP-vl retry/timeout khi VL busy | ❓ | Verify code, incident handling |
| Onboarding new ops → get token → setup Claude Desktop | ⚠️ | Có `mcp-setup-guide.md` nhưng chưa tự động |

**Kết luận MCP**: sẵn cho 3-5 ops power user tại pilot. Scale 5→10+ ops đồng thời cần rate limit + cache + per-user token.

---

## 5. Rủi ro lớn nhất nếu vẫn deploy 200 srv ngay

1. **Silent data loss**: chưa monitor thực → Vector/Indexer chết đêm khuya, ops phát hiện qua Claude báo "không có log 6h qua" = quá trễ cho incident forensic.
2. **Disk full cascade**: no retention → VL fill disk → Vector không ingest được → clients rsyslog buffer đầy → clients disk full → outage lan sang production services.
3. **PII leak vào Qdrant embedding**: Drain3 template chứa email/token → gửi qua Claude API → data breach compliance risk.
4. **MCP shared token compromise**: 1 người leak token trên GitHub → toàn bộ log accessible, không revoke selective được.
5. **Single-node crash = 100% downtime**: 200 srv rely 1 VM, không có HA, MTTR = restore snapshot 1-2h + risk data loss cửa sổ 24h (snapshot daily).
6. **LLM cost blowup**: 5 ops × 50 query/day × ~$0.5/query = ~$3.7k/tháng chưa cap.

---

## 6. Roadmap đề xuất (12 tuần)

**Tuần 1-2**: P0 (5 items) — backup offsite, monitoring cơ bản, PII rules mail/hosting, retention, mock-logs off. Verify healthcheck xanh 7 ngày.

**Tuần 3-4**: Pilot 3 srv (mail nội bộ + 2 hosting ít traffic). Ops team 2-3 người tập dùng MCP daily. Ghi runbook thực tế từ incident thật.

**Tuần 5-6**: P1 (runbook 5 incident, per-user MCP token, disk queue drill, capacity benchmark). Onboard thêm 5-10 srv sau soak 7 ngày.

**Tuần 7-8**: Onboard 30-50 srv. Đo threshold HA (indexer lag, disk growth, Qdrant size, LLM spend). Deploy Redis semantic cache + rate limit MCP.

**Tuần 9-10**: HA prep — indexer horizontal + NATS cluster + Drain3 state → Redis. VL retention tune sau benchmark thật.

**Tuần 11-12**: HA VL + Qdrant cluster nếu chạm trigger. Onboard 200 srv theo batch 50/tuần. DR drill lần đầu.

---

## 7. Câu hỏi cần trả lời trước khi commit roadmap

1. **Logserver prod spec cụ thể**: RAM/CPU/disk = ? Nếu chỉ = lab spec (~16GB RAM / 500GB SSD) → chỉ chịu ~30-50 srv single-node. Cần bump hardware hoặc HA sớm.
2. **200 srv ngày ~ ước lượng volume GB/ngày**? (2GB × 200 = 400GB; nếu chỉ 500MB × 200 = 100GB — khác 4× cho sizing).
3. **Ops team hiện tại số người**? Nếu chỉ 1-2 người kiêm nhiệm → không đủ on-call cho 200 srv, phải thuê thêm.
4. **NAS/MinIO nội bộ đã có chưa** cho offsite backup?
5. **Anthropic API budget/tháng ceiling**? Ảnh hưởng có cần multi-key + cache aggressive không.
6. **SLA cam kết downstream** (users dựa vào log): 99% hay 99.9%? 99.9% = bắt buộc HA sớm.
7. **Retention policy business/legal**: 14d, 30d, 90d? Ảnh hưởng disk sizing 3×.
8. **200 srv là 1 batch hay ramp**? Nếu ramp 20/tháng suốt năm thì có thời gian HA; nếu big-bang thì phải HA trước.

---

## 8. Bottom line

- **Kỹ thuật**: core stack (Vector + VL + Qdrant + MCP) đã proven trên lab, code quality tốt, doc kỷ luật. Không phải rewrite gì.
- **Operations**: **chưa maturity** cho 200 srv. Thiếu monitoring, backup offsite, HA, per-user auth, capacity data.
- **Đề xuất**: **không go-live 200 srv trong 1 tháng tới**. Pilot 3 → 30 → 100 → 200 theo 12-tuần roadmap. Mỗi bước gate bằng SLI thực.
- **MCP Claude cho ops**: sẵn cho 3-5 ops pilot. Scale team cần rate limit + cache + per-user token (2 tuần work).

Nếu bắt buộc go-live 200 srv < 1 tháng vì lý do business: chấp nhận 3 rủi ro — silent data loss cửa sổ giờ, 100% downtime khi VM chết, LLM cost không cap. Đó là trade-off người quyết định, không phải kỹ thuật.
