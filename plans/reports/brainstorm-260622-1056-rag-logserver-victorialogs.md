# Brainstorm Report — RAG cho Log Server (VictoriaLogs + Vector + Qdrant + Telegram)

- Date: 2026-06-22 10:56
- Author: brainstorm session
- Status: Design approved by user, pending plan
- Scope: Single-node MVP, roadmap lên cluster

---

## 1. Problem statement

Sysadmin vận hành ~50–200 server (cloud + mail server) cần truy vấn nhanh log để: (1) hỏi-đáp sự cố realtime, (2) RCA hậu sự cố, (3) tra runbook qua log lịch sử, (4) triage alert. UI là Telegram bot, hỏi free-form. Hệ thống log đã chọn VictoriaLogs + Vector.dev. Cần thiết kế RAG kết nối LLM (Claude Sonnet) với log store sao cho rẻ, không hallucinate, không leak PII.

## 2. Constraints & decisions (đã chốt với user)

| Mục | Quyết định |
|---|---|
| Use case | Realtime Q&A + RCA + KB lookup + Alert enrichment (4-in-1) |
| LLM | Claude Sonnet (API ngoài) |
| Vector DB | Qdrant single-node |
| Data source | Chỉ VictoriaLogs (không index runbook/wiki/config) |
| Scale target | 50–200 server, 10–100GB log/ngày |
| Indexing | Chỉ embed ERROR/WARN + anomaly (Drain3 template dedupe) |
| Telegram UX | Free-form, agent tool-use |
| Privacy | Bắt buộc PII/secret redaction trước khi embed & gửi LLM |
| Metrics correlation | Không (chưa có VictoriaMetrics) |
| Alertmanager | Triển khai sau hoặc song song |
| Sysadmin đồng thời | 2–3 user |
| Multi-tenant | Không |

## 3. Approaches đã đánh giá

### A. RAG cổ điển (embed query → top-k → stuff context)
- Pros: đơn giản, ít token.
- Cons: free-form question hỏi log thì semantic top-k thường miss; không kiểm chứng được; hallucinate cao.
- → **Loại**.

### B. Agent tool-use (LLM tự gọi search_qdrant + query_victorialogs)
- Pros: LLM tự quyết, verify được bằng raw log (LogsQL), citation rõ ràng.
- Cons: token nhiều hơn, latency cao hơn (multi-turn).
- → **Chọn**. Phù hợp với Sonnet (tool-use mạnh) + free-form UX.

### C. Pure LogsQL bot (không vector)
- Pros: cực rẻ, không cần Qdrant.
- Cons: LLM phải tự đoán LogsQL từ câu hỏi mơ hồ → recall kém với log semantic tương đương ("mail chậm" vs "smtp timeout").
- → **Loại** như primary, nhưng giữ LogsQL làm verification tool.

## 4. Final architecture

```
[Servers] --syslog/journald--> [Vector.dev]
                                   |
                ┌──────────────────┼─────────────────────┐
                v                                        v
        [VictoriaLogs]                          [Filter stream: WARN+]
        (primary, 30-90d retention)                      |
                ^                                        v
                |                                  [Indexer worker]
                |                                  - Drain3 template
                |                                  - Presidio redact
                |                                  - Embed (Voyage/OpenAI)
                |                                        |
                |                                        v
                |                                    [Qdrant]
                |                                        ^
                |                                        |
                +---<--[RAG Agent (FastAPI + LangGraph)]-+
                              ^
                              |
                       [Telegram Bot]  <-- (later) Alertmanager
                              ^
                              |
                          Sysadmin (2-3)
```

### Components

| Layer | Tool | Note |
|---|---|---|
| Collector | Vector.dev | Route VictoriaLogs + tap stream WARN+ qua local socket/NATS |
| Primary store | VictoriaLogs | LogsQL endpoint cho agent verify |
| Dedupe | Drain3 | Gom log template, cập nhật count/host/window |
| Redaction | Presidio + regex (IP nội bộ, JWT, AWS key, password) | Chạy trước embed |
| Embedding | `text-embedding-3-small` (1536d) | $0.02/1M tokens, rẻ; có thể đổi `bge-m3` local sau |
| Vector DB | Qdrant 1.x single-node, disk persist | Payload index: service, host, severity, ts |
| LLM | Claude Sonnet (Anthropic API) | Tool-use, streaming |
| Agent runtime | FastAPI + LangGraph (Python 3.12) | Stateless, session cache in Redis |
| Cache | Redis | Session 10' + semantic query cache |
| Bot | python-telegram-bot v21 | Whitelist chat_id |
| Secrets | sops / age (file-based, single-node) | Plan Vault khi cluster |

### Agent tools

1. `search_log_templates(query, service?, host?, time_range?, k=10)` — Qdrant semantic + filter
2. `query_victorialogs(logsql, time_range, limit=200)` — verify raw, dùng khi cần grep cụ thể
3. `summarize_window(service, time_range)` — pre-aggregate count theo template
4. `list_services()` / `list_hosts()` — discovery
5. (phase 2) `get_recent_alerts(time_range)` khi tích hợp Alertmanager

### Output contract
- Mọi câu trả lời bắt buộc cite `service:host:timestamp` lấy từ tool result. Không có citation → từ chối trả lời.
- Streaming edit message Telegram, inline button `[Xem raw]` `[Mark resolved]`.

## 5. Indexing pipeline chi tiết

1. Vector filter `severity >= WARN`.
2. Drain3 cluster theo `service` (mỗi service 1 model state riêng, persist disk hằng giờ).
3. Window 30s hoặc batch 500 templates.
4. Redact PII.
5. Build chunk:
   ```
   service=postfix host=mail-01 severity=ERROR
   window=2026-06-22T10:25:00..10:25:30Z
   template: "connect from <IP>: lost connection after AUTH"
   count: 1247, hosts_affected: 2
   sample: "...redacted..."
   ```
6. Embed → upsert Qdrant `{id=hash(template+window), payload={service,host,severity,ts_start,ts_end,template_id,count}}`.
7. TTL/retention Qdrant 90 ngày (script cleanup daily).

Ước tính sau dedupe: 5k–30k vector/ngày → ~10M/năm, đĩa Qdrant <50GB.

## 6. Sizing single-node

| Resource | Spec |
|---|---|
| CPU | 16 vCPU |
| RAM | 32GB |
| Disk | SSD 1TB (VictoriaLogs ~700GB, Qdrant ~50GB, OS+log ~250GB) |
| Network | 1Gbps |
| OS | Ubuntu 22.04/24.04 LTS |
| Deploy | docker-compose (MVP) → systemd unit cho prod |

## 7. Security

- Redaction 2 lớp: indexer (trước embed) + agent (trước gọi LLM raw log).
- API key Anthropic + OpenAI lưu sops-encrypted.
- Telegram bot whitelist chat_id, role admin/viewer trong config.
- Audit log mọi prompt + tool call vào file riêng (JSONL).
- Outbound LLM giới hạn qua egress proxy (chỉ allow api.anthropic.com, api.openai.com).

## 8. Cost estimate (tháng, 2–3 sysadmin)

| Item | Ước tính |
|---|---|
| Embedding (30k chunks/ngày × 200 tokens) | ~$4/tháng |
| Sonnet (100 query/ngày × ~10k token in / 1k out, tool-use 2-3 turn) | ~$120–180/tháng |
| Semantic cache hit ~30% → giảm ~$50 | net ~$80–130/tháng |
| Hạ tầng VM | tuỳ provider |

## 9. Roadmap → cluster

| Phase | Hành động |
|---|---|
| MVP single-node | Như trên |
| +Alerting | Alertmanager → webhook → agent pre-compute triage, push Telegram |
| +Metrics | Thêm VictoriaMetrics tool `query_metrics` để correlate |
| HA | VictoriaLogs tách vlinsert/vlselect/vlstorage; Qdrant 3-node sharded+replica; indexer chuyển Kafka/NATS consumer group |
| Multi-region | replica Qdrant cross-region, VictoriaLogs downsampling |

## 10. Implementation considerations & risks

- **Hallucination**: agent BUỘC verify bằng `query_victorialogs` trước kết luận RCA. Prompt system enforce.
- **Drain3 drift**: retrain weekly, monitor `unmatched_ratio` > 5% → alert.
- **Miss anomaly ở INFO**: bổ sung statistical anomaly (z-score count/min) ở Vector → đẩy thêm event vào indexer stream.
- **LLM cost spike**: rate-limit 30 query/sysadmin/giờ, semantic cache, fallback Haiku cho follow-up đơn giản.
- **Qdrant single-node SPOF**: snapshot daily → S3/MinIO, restore script test hàng tháng.
- **Telegram offline**: bot retry exponential, queue trong Redis.

## 11. Success metrics

- p95 thời gian trả lời < 8s (tool 1-turn), < 15s (2-3 turn).
- Recall RCA: ≥80% câu hỏi sysadmin trả ra đúng service/host/window (đánh giá thủ công 50 case đầu).
- Hallucination rate (kết luận không có citation hợp lệ) < 2%.
- Drain3 unmatched ratio < 5%.
- Cost LLM < $200/tháng phase MVP.
- Uptime bot ≥ 99%.

## 12. Validation criteria (test plan rút gọn)

- 20 câu hỏi mẫu (mail down, ssh brute force, disk full, OOM, certificate expire, postfix queue, etc.) → đánh giá đúng/sai/partial.
- Test redaction: inject log có email + IP private + JWT giả → kiểm tra không xuất hiện trong Qdrant payload và prompt LLM.
- Load test indexer: replay 50GB log/ngày → đo lag < 2 phút.
- Restore test: snapshot Qdrant + restore từ đầu < 30 phút.

## 13. Next steps & dependencies

1. Tạo plan triển khai theo phase qua `/ck:plan`:
   - Phase 1: Hạ tầng (VM, docker-compose, VictoriaLogs, Qdrant)
   - Phase 2: Vector.dev pipeline + Drain3 + Redaction + Indexer worker
   - Phase 3: RAG Agent service (FastAPI + LangGraph + tools)
   - Phase 4: Telegram bot + whitelist + audit
   - Phase 5: Eval harness (20 test cases) + tuning prompt
   - Phase 6 (song song/sau): Alertmanager integration
   - Phase 7: HA roadmap doc
2. Dependencies: Anthropic API key, OpenAI key (embedding), VM 16/32/1TB, Telegram bot token, chat_id whitelist.

## 14. Unresolved questions

- Có cần lưu lịch sử Q&A lâu dài (>30 ngày) cho fine-tune/eval không?
- Drain3 model state có cần version/backup riêng (mất state = lost dedupe history)?
- Có cần feedback loop (sysadmin react 👍/👎 trên Telegram → ghi nhận để cải thiện prompt) ngay MVP hay phase sau?
- Embedding model: ưu tiên `text-embedding-3-small` (rẻ, cloud) hay `bge-m3` local (privacy hơn, cần GPU/CPU mạnh)?
