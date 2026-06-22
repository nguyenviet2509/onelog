# Brainstorm: Hệ thống RAG tích hợp VictoriaLogs

> Ngày: 2026-06-18 | Loại: brainstorm | Trạng thái: chờ review

---

## 1. Problem Statement

Xây dựng hệ thống **RAG (Retrieval-Augmented Generation)** cho phép vận hành viên / SOC / DevOps **hỏi đáp tự nhiên (NLQ)** trên kho log đang lưu tại **VictoriaLogs (VL)**.

Ví dụ câu hỏi thực tế:
- "Tối qua server `web-01` có lỗi 5xx bất thường không?"
- "Tóm tắt cụm cảnh báo SSH brute-force trong 24h qua."
- "Vì sao dịch vụ `payment` bị timeout lúc 03:15?"
- "So sánh pattern lỗi giữa `app-prod` và `app-staging` tuần này."

→ LLM cần **lấy log đúng (retrieval) → tóm tắt/giải thích (generation)** thay vì user phải tự viết LogsQL.

---

## 2. Tại sao RAG (không phải fine-tune)?

| Tiêu chí | Fine-tune | RAG |
|---|---|---|
| Dữ liệu mới mỗi giây | ❌ phải train lại | ✅ query realtime |
| Cardinality log cao | ❌ blow up | ✅ chỉ retrieve top-k |
| Cost | ❌ GPU train | ✅ inference + DB cost |
| Truy vết nguồn | ❌ hallucinate | ✅ cite log line gốc |
| **Phù hợp log** | ❌ | ✅✅✅ |

→ **RAG là lựa chọn đúng cho log analytics.**

---

## 3. Đặc thù RAG-trên-Log (khác RAG-trên-Doc thường)

| Khía cạnh | RAG doc thường (PDF, wiki) | RAG log |
|---|---|---|
| Dữ liệu | Tĩnh, ngữ nghĩa | Time-series, structured, volume khủng |
| Chunking | Theo đoạn văn | Theo time window + stream |
| Index chính | Vector DB | **LogsQL + Vector (hybrid)** |
| Truy vấn | Semantic match | **Time + filter + (semantic)** |
| Latency yêu cầu | Vài giây | Sub-second cho live debug |

> **Insight quan trọng:** với log, **structured retrieval (LogsQL) thường thắng vector search**. Vector chỉ dùng cho câu hỏi mơ hồ ngữ nghĩa ("lỗi liên quan thanh toán"). → Cần **hybrid retrieval**.

---

## 4. Ba phương án kiến trúc

### Approach A — **NL2LogsQL** (thuần structured, no vector)
LLM dịch câu hỏi tự nhiên → câu LogsQL → chạy thẳng trên VL → LLM tóm tắt kết quả.

```
User Q ──► LLM (NL→LogsQL) ──► VictoriaLogs ──► LLM (summarize) ──► Answer
```

- ✅ Đơn giản, KISS, không cần vector DB
- ✅ Tận dụng full-text + inverted index sẵn có của VL
- ✅ Truy vết chính xác (cite log line gốc)
- ❌ Phụ thuộc khả năng LLM viết LogsQL đúng (cần few-shot tốt)
- ❌ Yếu với câu hỏi ngữ nghĩa mơ hồ

### Approach B — **Vector-only RAG** (embed toàn bộ log)
Embed mỗi log line / cụm log → lưu vector DB (Qdrant/Milvus) → semantic search → LLM.

- ✅ Tốt cho câu hỏi mơ hồ
- ❌ **Cost embedding khổng lồ** (log volume = TB/ngày)
- ❌ Mất context thời gian
- ❌ Trùng lặp với index có sẵn của VL
- ❌ **Anti-pattern cho log → loại**

### Approach C — **Hybrid: NL2LogsQL + Selective Vector** ⭐ (đề xuất)
LLM router quyết định:
- Câu hỏi có entity rõ (host, time, error code) → **NL2LogsQL** path
- Câu hỏi mơ hồ ngữ nghĩa → **Vector path** (chỉ embed log đã được cluster/dedupe trước, không embed raw)
- Mọi câu trả lời đều **cite log line gốc** từ VL

- ✅ Cân bằng cost & accuracy
- ✅ Cite được nguồn
- ✅ Scale được
- ❌ Phức tạp hơn A
- ❌ Cần log clustering pipeline (Drain3 / LogReducer) → tạo template trước khi embed

---

## 5. Kiến trúc đề xuất (Approach C)

```
┌──────────────────────────────────────────────────────────────────────┐
│                         UI Layer (Web Chat)                          │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │  Chat box │ Time picker │ Service filter │ Cited log panel │    │
│   └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────┬────────────────────────────────────────┘
                              │ REST/WebSocket
┌─────────────────────────────▼────────────────────────────────────────┐
│                       RAG Orchestrator (Go/Python)                   │
│                                                                      │
│   ┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐    │
│   │  Query       │──►│  Intent Router   │──►│  Retrieval Plan  │    │
│   │  Parser      │   │  (LLM-classify)  │   │                  │    │
│   └──────────────┘   └──────────────────┘   └────────┬─────────┘    │
│                                                      │              │
│            ┌─────────────────────────────────────────┤              │
│            │                       │                 │              │
│   ┌────────▼────────┐    ┌─────────▼────────┐  ┌─────▼──────────┐  │
│   │  NL→LogsQL      │    │  Vector Search   │  │  Time/Metric   │  │
│   │  (few-shot LLM) │    │  (Qdrant)        │  │  Aggregator    │  │
│   └────────┬────────┘    └─────────┬────────┘  └─────┬──────────┘  │
│            │                       │                 │              │
│            └─────────────┬─────────┴─────────────────┘              │
│                          │                                          │
│                  ┌───────▼────────┐                                 │
│                  │  Context Pack  │   ← top-k logs + metadata       │
│                  │  + Dedupe      │                                 │
│                  └───────┬────────┘                                 │
│                          │                                          │
│                  ┌───────▼────────┐                                 │
│                  │  LLM Generator │   ← prompt + cite               │
│                  │  (Claude/GPT)  │                                 │
│                  └───────┬────────┘                                 │
└──────────────────────────┼──────────────────────────────────────────┘
                           │
                           ▼  Answer + citations
                   ┌──────────────┐
                   │   User UI    │
                   └──────────────┘

┌──────────────────────── DATA PLANE ────────────────────────────────┐
│                                                                    │
│   syslog/rsyslog ──► vlinsert ──► vlstorage (VictoriaLogs)        │
│                                       │                            │
│                                       ├──► LogsQL API (live read)  │
│                                       │                            │
│                                       └──► Periodic Job:           │
│                                            • Drain3 log clustering │
│                                            • Embed templates only  │
│                                                    │               │
│                                                    ▼               │
│                                            ┌──────────────┐        │
│                                            │  Qdrant /    │        │
│                                            │  Milvus      │        │
│                                            │  (template   │        │
│                                            │   vectors)   │        │
│                                            └──────────────┘        │
└────────────────────────────────────────────────────────────────────┘
```

---

## 6. UI Mockup (để review)

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔍 LogSense AI                          [user@inet]  [⚙ Settings]│
├──────────────┬──────────────────────────────────────────────────┤
│              │  Time: [Last 24h ▾]   Service: [all ▾]  Env:[prod]│
│ 💬 Sessions  ├──────────────────────────────────────────────────┤
│ ────────────│                                                  │
│ • SSH brute  │  🧑 Tối qua web-01 có lỗi 5xx bất thường không? │
│ • Payment    │                                                  │
│   timeout    │  🤖 Có. Phát hiện 1,247 lỗi 5xx trong khoảng    │
│ • DB slow    │     22:00–23:30, tập trung endpoint /api/order. │
│              │     Root cause khả năng: upstream `payment-svc` │
│ + New chat   │     timeout (xem citation #3).                  │
│              │                                                  │
│              │   📎 Citations:                                  │
│              │   ┌──────────────────────────────────────────┐  │
│              │   │ [1] 22:03:14 web-01 nginx 502            │  │
│              │   │     upstream timeout payment-svc:8080    │  │
│              │   │ [2] 22:03:15 ... (×1,245 events)         │  │
│              │   │ [3] LogsQL: _stream:{host="web-01"} ...  │  │
│              │   │     [Open in Grafana] [Export]            │  │
│              │   └──────────────────────────────────────────┘  │
│              │                                                  │
│              │  ┌────────────────────────────────────────────┐ │
│              │  │ Hỏi tiếp...                          [Send]│ │
│              │  └────────────────────────────────────────────┘ │
└──────────────┴──────────────────────────────────────────────────┘
```

**Thành phần UI chính:**
1. **Sidebar**: lịch sử chat (mỗi case = 1 session)
2. **Filter bar**: time picker, service, env (giảm scope retrieval)
3. **Chat panel**: hội thoại multi-turn
4. **Citation panel**: log line gốc, có deeplink sang Grafana/VL UI
5. **Action buttons**: Export, Share, Convert-to-Alert

---

## 7. Tech Stack đề xuất

| Layer | Lựa chọn | Lý do |
|---|---|---|
| Log store | **VictoriaLogs** (đã có) | Native, đã chốt |
| Orchestrator | **Python (FastAPI)** hoặc **Go** | Py có hệ sinh thái LLM tốt hơn |
| LLM | **Claude Sonnet 4.6** (default) + fallback local (Qwen/Llama via Ollama) | Cost-quality balance |
| Embedding | `bge-m3` hoặc `text-embedding-3-small` | Multilingual (VN) |
| Vector DB | **Qdrant** (single binary, giống triết lý VL) | KISS |
| Log clustering | **Drain3** | Chuẩn industry |
| UI | **Next.js + shadcn/ui** | Nhanh, đẹp |
| Auth | OIDC qua existing IdP | Tận dụng hạ tầng |

---

## 8. Risk & Mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| LLM viết LogsQL sai → 0 kết quả hoặc query nặng | High | Few-shot + schema-aware prompt + dry-run validator + `LIMIT` cứng |
| Hallucination | High | **Bắt buộc cite log_id**, refuse nếu không có context |
| Cost LLM tăng theo log volume | Medium | Cache, dedupe template, chỉ pass top-k log vào prompt |
| Leak dữ liệu nhạy cảm sang LLM cloud | High | PII redaction layer trước khi gửi prompt; option local LLM |
| Query nặng đè VL | Medium | Rate limit + time-window cap (max 7d/query) |
| Latency cao | Medium | Stream response, parallel retrieval |

---

## 9. Phased Roadmap

**Phase 1 — MVP (2-3 tuần)**: Approach A thuần (NL2LogsQL), 1 LLM, UI chat đơn giản, 10 case study mẫu.
**Phase 2 — Hybrid (3-4 tuần)**: Thêm Drain3 + Qdrant cho câu hỏi ngữ nghĩa.
**Phase 3 — Production (4+ tuần)**: PII redaction, RBAC, audit log, alert-conversion, multi-tenant.

---

## 10. Success Metrics

- **Accuracy**: ≥80% câu hỏi có citation đúng (đánh giá tay 100 mẫu)
- **Latency p95**: <5s end-to-end cho câu hỏi 24h-range
- **Adoption**: ≥50% SOC/DevOps dùng tuần đầu sau release
- **Cost**: <$0.05/query trung bình

---

## 11. Câu hỏi cần làm rõ (cho user review)

1. **LLM**: được phép dùng cloud (Claude/OpenAI) hay **bắt buộc on-prem** (lý do compliance log nội bộ)?
2. **Scale dự kiến**: log volume bao nhiêu GB/ngày? Bao nhiêu user đồng thời?
3. **Phạm vi user**: chỉ team nội bộ (SOC/DevOps) hay mở cho dev/PM khác?
4. **Tích hợp**: cần plug vào Grafana hiện tại (panel) hay đứng riêng (standalone web)?
5. **Ngôn ngữ**: chỉ tiếng Việt, chỉ EN, hay cả hai?
6. **Đa nguồn**: có cần kết hợp metrics (VictoriaMetrics) + traces không, hay chỉ log?

---

## 12. Quyết định chốt (2026-06-18)

| Hạng mục | Chốt |
|---|---|
| **Approach** | **C — Hybrid NL2LogsQL + Selective Vector** |
| **LLM hosting** | **On-prem only** (log nội bộ, compliance) — Ollama + Qwen2.5-32B hoặc Llama-3.3-70B trên GPU server |
| **Embedding** | **Local** `bge-m3` (multilingual, tiếng Việt tốt) |
| **Scale target** | **>500GB/ngày, >50 user đồng thời** → VL **cluster mode** (vlinsert/vlstorage/vlselect), orchestrator horizontal scale, Qdrant cluster |
| **User scope** | **SOC/DevOps + Dev/PM** → **RBAC bắt buộc** theo service/env, PII redaction layer |
| **UI** | **Standalone Next.js web app** (shadcn/ui) |
| **Ngôn ngữ** | **Tiếng Việt only** (prompt + UI + tài liệu) |
| **Phạm vi tín hiệu** | **Chỉ log** (không metrics/traces ở v1) |

### Điều chỉnh kiến trúc theo chốt

- **VL deploy cluster mode** (không single-node) — đáp ứng >500GB/ngày
- **Orchestrator stateless** → scale ngang sau load balancer
- **GPU node riêng** cho LLM (Ollama) + embedding service
- **RBAC tier**:
  - SOC/DevOps: full access
  - Dev: chỉ service team mình + env (dev/staging), prod cần approval
  - PM: chỉ summary/dashboard, không thấy raw log
- **PII redaction** trước khi log line vào prompt (regex + named-entity, mask IP/email/token)
- **Prompt + few-shot ví dụ LogsQL bằng tiếng Việt**, response sinh tiếng Việt

### Capacity sizing thô

| Component | Spec đề xuất |
|---|---|
| vlstorage | 3 node × (16 vCPU, 64GB RAM, 4TB NVMe) — retention 30d nén ~50:1 |
| vlinsert/vlselect | 2 node × (8 vCPU, 16GB RAM) mỗi vai trò |
| LLM GPU | 1-2 × A100 40GB (Qwen2.5-32B) hoặc 2 × A100 80GB (Llama-3.3-70B) |
| Embedding | 1 × T4/A10 (bge-m3) |
| Qdrant | 3 node × (8 vCPU, 32GB RAM, 500GB SSD) |
| Orchestrator | 2-4 pod stateless |
| Web (Next.js) | 2 pod + CDN |

---

## 13. Next Step

→ Chạy `/ck:plan` để sinh chi tiết phase-by-phase implementation plan dựa trên brainstorm này.

**Status:** ✅ ĐÃ CHỐT — sẵn sàng chuyển sang planning phase.
