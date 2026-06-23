# Phase 06 — Alertmanager + Telegram alert bot minimal (song song / sau MVP)

## Context
- Plan: [plan.md](plan.md)
- Design: [brainstorm report §1, §9 roadmap](../reports/brainstorm-260622-1056-rag-logserver-victorialogs.md)

## Overview
- Priority: P1 (có thể chạy song song sau Phase 01)
- Status: **MVP slice scaffolded 2026-06-23**. vmalert + Alertmanager trong compose (profile `alerts`), 4 LogsQL rule (ssh_brute, mysql_err_burst, audit_login_fail, nginx_5xx). Agent `/alert` webhook: in-memory TTL dedupe → triage qua agent_loop → Telegram direct push (TELEGRAM_MOCK fallback). KHÔNG có bot service riêng / inline button — slice 2 thêm khi cần ack/silence.
- Mục tiêu: Alertmanager webhook → agent pre-compute triage → push Telegram topic với tóm tắt + suggested action + deep link về Web. **Telegram bot ở phase này là MINIMAL one-way** (~100 LOC, không Q&A — Q&A đã chuyển sang Web Phase 04).

## Requirements
- Latency từ alert fire → Telegram < 30s
- Triage có citation log liên quan
- Dedupe alert (group_key) tránh spam

## Architecture
```
vmalert / Alertmanager
   │ webhook POST /alert
   ▼
Enrichment worker (Python, có thể gộp vào agent service)
   ├── parse Alertmanager payload
   ├── extract service/host/time_window
   ├── gọi agent /chat với prompt "Triage alert: {summary}, retrieve log {window}"
   ├── format Telegram message + inline button
   └── push qua bot API
```

## Related Code Files
Create:
- `agent/src/agent/alert_handler.py` (route `/alert`)
- `agent/src/agent/alert_formatter.py`
- `agent/src/agent/alert_dedupe.py` (Redis SET group_key TTL)
- `infra/vmalert/rules.yaml` (sample rules: disk_full, oom, postfix_queue_high, ssh_brute)
- `infra/docker-compose.yml` (add `vmalert`, `alertmanager`)
- `bot/src/bot/alert_push.py` (endpoint nhận formatted message từ agent)

## Implementation Steps
1. Thêm vmalert + Alertmanager vào compose
2. Viết 5-10 alert rule LogsQL cơ bản:
   - disk_full: `_stream:{filename="/var/log/syslog"} "No space left"` count > 0
   - oom: `"Out of memory"` count > 0
   - postfix_queue: `service=postfix "queue size"` parse value > 1000
   - ssh_brute: `service=sshd "Failed password"` count > 50 / 5m / host
3. Alertmanager config: route → webhook `http://agent:8080/alert`
4. Agent route `/alert`:
   - dedupe theo `alert.fingerprint` (Redis SET TTL 1h)
   - extract context, gọi nội bộ `chat()` với prompt template
   - format message Telegram (markdown, citation)
   - POST sang bot `/push` với chat_id từ alert label `team`
5. Bot minimal (~100 LOC): nhận POST `/push` từ agent → sendMessage Telegram + inline keyboard `[Ack]` `[Mở Web]` (deep link `https://app.company.com/chat?alert_id=xxx` hoặc `/trace?...`) `[Silence 1h]`. KHÔNG xử lý message handler / Q&A.
6. Test: trigger alert thủ công bằng curl Alertmanager API → verify Telegram nhận trong 30s

## Todo
- [ ] vmalert + alertmanager compose
- [ ] Rule yaml 5-10 alert
- [ ] Alertmanager webhook config
- [ ] Agent /alert handler + dedupe
- [ ] Alert formatter (markdown)
- [ ] Bot /push endpoint
- [ ] Inline action buttons (ack/silence)
- [ ] E2E test trigger → Telegram
- [ ] Doc alert-runbook.md

## Success Criteria
- Alert → Telegram < 30s p95
- 0 duplicate alert trong window dedupe
- Triage message có ≥ 1 citation hợp lệ
- Action button work (ack ghi audit, silence gọi Alertmanager API)

## Risks
- Alert storm → rate limit push, group by alertname
- Agent overload khi nhiều alert đồng thời → queue + worker pool
- LLM cost spike → cache theo alertname+host trong 15 phút

## Security
- Webhook chỉ accept từ docker network nội bộ
- Silence action yêu cầu user có role admin

## Next Steps
- Sau khi ổn, thêm correlation cross-alert (Phase HA roadmap)
