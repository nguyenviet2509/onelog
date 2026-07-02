---
title: LLM Provider Abstraction cho OneLog
slug: llm-provider-abstraction
date: 2026-07-01
status: pending
owner: anhtct@inet.vn
brainstorm: ../reports/brainstorm-260701-1544-llm-provider-abstraction.md
blockedBy: []
blocks: []
---

# Plan — LLM Provider Abstraction

## Mục tiêu
Tách OneLog khỏi Claude, cho phép chạy GPT / Gemini / DeepSeek với 1 env var. Driver: **giảm chi phí** (Gemini Flash / DeepSeek rẻ hơn Claude Sonnet 3-10x).

## Bối cảnh
- Agent service (`agent/src/agent/llm_client.py`) hard-code Anthropic SDK.
- End-user hiện dùng Claude Desktop làm MCP host.
- MCP servers đã LLM-agnostic — không đổi.

Xem chi tiết design: [brainstorm report](../reports/brainstorm-260701-1544-llm-provider-abstraction.md).

## Phases

| # | Phase | Status | Effort | File |
|---|---|---|---|---|
| 1 | Agent service LiteLLM abstraction | **completed** (mock) | 1 ngày | [phase-01-agent-litellm-abstraction.md](phase-01-agent-litellm-abstraction.md) |
| 2 | LiteLLM proxy container | **completed** (config) | 0.5 ngày | [phase-02-litellm-proxy-container.md](phase-02-litellm-proxy-container.md) |
| 3 | OpenWebUI deploy + MCP wiring | **completed** (config) | 1 ngày | [phase-03-openwebui-deploy.md](phase-03-openwebui-deploy.md) |
| 4 | Benchmark VI 20-query 4 providers | pending | 0.5 ngày | [phase-04-vi-benchmark.md](phase-04-vi-benchmark.md) |
| 5 | Docs sync + team migration | pending | 0.5 ngày | [phase-05-docs-sync.md](phase-05-docs-sync.md) |

**Tổng effort:** ~3.5 ngày.

## Dependencies

- Phase 1 độc lập, có thể chạy song song với Phase 2.
- Phase 3 depend Phase 2 (LiteLLM proxy phải chạy trước).
- Phase 4 depend Phase 1 + Phase 2 (cần agent + proxy).
- Phase 5 depend Phase 3 (docs mô tả OpenWebUI workflow).

Order đề xuất: `1 || 2` → `3` → `4` → `5`.

## Success criteria toàn cục
- Agent `/chat` pass full test suite với `LLM_PROVIDER=gemini` VÀ `LLM_PROVIDER=anthropic` (parity).
- OpenWebUI accessible cho 5 ops, MCP tools list được từ cả `onelog-vl` + `onelog-semantic`.
- Cost/1000 queries giảm ≥ 60% so với Claude Sonnet baseline (measurable qua LiteLLM logs).
- Tool-call success rate ≥ 95% trên 20-query VI benchmark cho top-3 provider.
- Team hoàn thành migration khỏi Claude Desktop trong 2 tuần sau Phase 5.

## Rủi ro chính
Xem section "Risks" trong brainstorm report. Highlights:
- Gemini/DeepSeek tool-use fidelity yếu hơn Claude → dựa citation validator hiện có.
- VI quality khác nhau giữa provider → Phase 4 benchmark bắt buộc trước prod switch.
- Provider API key sprawl → chỉ LiteLLM giữ keys, user auth qua OpenWebUI.

## Red Team Review (2026-07-01)

15 findings applied · 3 lens (Security Adversary, Assumption Destroyer, Failure Mode Analyst).

| # | Severity | Location | Fix summary |
|---|---|---|---|
| F1 | CRITICAL | phase-02 | Tách `.env.llm` chỉ mount vào litellm-proxy, chmod 0400 |
| F2 | HIGH | phase-03 | Bootstrap admin script + lock signup ngay lần up đầu, không có cửa sổ open |
| F3 | HIGH | phase-03 | MCP bearer token riêng cho OpenWebUI (`MCP_TOKEN_OPENWEBUI`), revoke độc lập |
| F4 | MEDIUM | phase-03 | Backup .tgz encrypt bằng age/gpg trước khi archive |
| F5 | CRITICAL | phase-01 | Thêm Phase 0.5 Spike (2h) verify LiteLLM tool-use parity 3 provider trước code |
| F6 | HIGH | phase-03 | Fallback path: OpenWebUI Functions/Pipelines nếu MCP native fail sau 2h debug |
| F7 | HIGH | phase-04 | Benchmark Claude cả 2 mode (caching-on/off); cost -88% là optimistic |
| F8 | MEDIUM | phase-04 | Test tool-call success qua MCP layer (OpenWebUI path), không chỉ direct LiteLLM |
| F9 | CRITICAL | phase-05 | Document kill-switch runtime (`POST /model/delete`) trong ops guide |
| F10 | HIGH | phase-02 | Validation callback: malformed response count as fail; max_budget hard cap |
| F11 | HIGH | phase-02, 05 | LiteLLM Postgres dùng schema riêng `litellm`, rollback DROP CASCADE |
| F12 | MEDIUM | phase-01, 02 | LiteLLM timeout 25s < AGENT_TIMEOUT_S 30s (tránh race orphan request) |
| F13 | MEDIUM | phase-03 | `depends_on: service_started` (không phải `service_healthy`) tránh boot deadlock |
| F14 | MEDIUM | phase-04 | Benchmark runner dùng subprocess per provider (Pydantic settings không hot-reload) |
| F15 | LOW | phase-05 | Migration governance: D+21 threshold cứng, escalate team lead nếu slip |

Phase file có marker `> **[RT-Fnn]**` tại điểm đã fix.

## Validation Log

### Session 1 · 2026-07-01 16:50 · 7 decisions

| # | Decision | Choice | Impact phase |
|---|---|---|---|
| V1 | OpenWebUI auth | **Local user table** (5 ops invite-only) | phase-03 |
| V2 | Provider API keys | **`.env.llm` chmod 0400 root** (RT-F1 confirmed) | phase-02 |
| V3 | Cost tracking backend | **Postgres schema `litellm`** (RT-F11 confirmed) | phase-02, 05 |
| V4 | Metrics export | **stdout JSON → VictoriaLogs** (tái dùng stack có sẵn) | phase-02 |
| V5 | Chat history retention | **Giữ vĩnh viễn** + backup daily encrypted | phase-03 |
| V6 | Budget alert threshold | **500,000 VND/tháng**, alert 80%, reject 100% | phase-02 |
| V7 | Claude prompt caching | **Enable default cho `anthropic/*` models** (RT-F7 confirmed) | phase-01, 04 |

Impact: đóng toàn bộ "Câu hỏi chưa giải quyết" gốc. Không câu hỏi mở còn lại.
