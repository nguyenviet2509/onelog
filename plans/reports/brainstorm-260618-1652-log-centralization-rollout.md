# Brainstorm: Log centralization rollout (prerequisite RAG)

> Ngày: 2026-06-18 16:52 | Loại: brainstorm | Merged vào plan: `260618-1624-rag-victorialogs-system/phase-00`

## Thực trạng
- Prometheus metrics: đã có
- Log VPS/Cloud: chưa tập trung
- Mail center: có log local, cần tập trung
- Triển khai: VL HA cluster mới

## Approach chốt
**Phased rollout per source** (Approach B), nâng Edge Aggregator nếu >3 DC.

## Quyết định chính
1. Agent: **Vector** cho mail/cloud (parse + redact mạnh), rsyslog cho VPS legacy forward sang Vector
2. Stream fields chuẩn: `service`, `host`, `env`, `dc`, `role` (đồng bộ Prometheus)
3. PII redact **tại agent** (không gửi raw qua WAN)
4. Grafana 1 nơi, datasource Prometheus + VictoriaLogs, variable đồng bộ
5. Log-based alert qua vmalert → Alertmanager chung Prometheus
6. Roadmap 8 tuần: cluster → wave VPS → wave Cloud → wave Mail → Grafana → alert → hardening

## Mapping vào plan RAG
Đã merge thành **Phase 00** của plan `260618-1624-rag-victorialogs-system`. Stage 1 = log platform, Stage 2 = RAG.

## Output
- [phase-00-log-centralization-rollout.md](../260618-1624-rag-victorialogs-system/phase-00-log-centralization-rollout.md)
- Plan overview updated: critical path 00 → 03 → 04 → 05/06 → 07 → 08

## Câu hỏi mở
Xem `plan.md` §Open Questions (Stage 1).
