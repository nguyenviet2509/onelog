# Migration plan — Claude Desktop → OpenWebUI

> Cutover timeline cho 5 ops. Governance cứng theo RT-F15 — không delay vô hạn.

## Prerequisites

- [x] Phase 1-3 deployed logserver-01 (verified 2026-07-02)
- [ ] Ít nhất 1 provider key thật (Anthropic hoặc Gemini)
- [ ] Phase 4 benchmark done — chốt default model
- [ ] 5 credentials OpenWebUI cấp sẵn
- [ ] Docs sync: openwebui-user-guide.md + mcp-setup-guide.md restructured

## Milestones

| Date | Milestone | Threshold pass | Action nếu miss |
|---|---|---|---|
| **D-7** | Admin dry-run stack prod | `docker compose ps` 3/3 healthy, smoke test /chat + webui OK | Block cutover, fix stack |
| **D-3** | Onboard 1 early adopter | 1 người login OK + gọi được 1 tool MCP | Fix blocker, delay 1-2 ngày |
| **D-1** | Team notification | 5/5 credentials cấp + link webui.local + hosts entry hướng dẫn | Không cutover |
| **D+0** | Team meeting 30ph (demo, Q&A) | 5/5 attend | Reschedule, không skip |
| **D+7** | Check usage OpenWebUI | ≥ 3/5 login + tạo chat thật | 1-1 onboarding người chưa |
| **D+14** | Revoke Claude Desktop MCP token đợt 1 | ≥ 4/5 active | Extend đến D+21, KHÔNG delay vô hạn |
| **D+21** | Revoke đợt 2 | 5/5 active | **Escalate team lead**, không tự delay tiếp |
| **D+30** | Post-mortem: cost saving thực vs prediction | Data đủ 30 ngày | Vẫn viết post-mortem với data có |

**D+0** = ngày cutover chính. Ấn định khi Phase 4 xong + keys sẵn.

## Buddy assignment

- Đôi 1: `<admin>` ↔ `<ops-1>` (early adopter D-3)
- Đôi 2: `<ops-2>` ↔ `<ops-3>`
- Đôi 3: `<ops-4>` ↔ `<ops-5>`

Buddy trách nhiệm: check pair có login được, tạo chat mẫu, gọi MCP tool thành công trong tuần đầu.

## D-7 dry-run checklist

- [ ] `docker compose --profile llm --profile chat --profile agent ps` → 3 healthy
- [ ] `curl /health/liveliness` LiteLLM OK
- [ ] `curl /v1/models` list đủ 4 alias
- [ ] Login `webui.local` bằng admin, tạo chat, gọi `search_log_templates` → citation OK
- [ ] Fallback smoke: tạm rename `GEMINI_API_KEY` → verify auto route gpt-4-mini
- [ ] Backup cron `backup-openwebui.sh` chạy dry-run OK
- [ ] Kill-switch smoke: `POST /model/delete` rồi re-add — không downtime

## D-1 team notification template

Gửi Slack `#ops` + email cá nhân:

```
Subject: [Action] OpenWebUI cutover D+0 (<date>)

Team,

Từ <date>, chuyển sang OpenWebUI thay Claude Desktop cho log investigation.

Việc cần làm trước D+0:
1. Thêm hosts entry: 192.168.122.53 webui.local
   - Windows/mac hướng dẫn: docs/openwebui-user-guide.md §1
2. Login credentials: gửi riêng qua kênh private (KHÔNG Slack public)
3. Đọc docs/openwebui-user-guide.md (5 phút)

D+0 <date HH:MM>: meeting 30ph demo + Q&A. Link Meet: <link>.

Claude Desktop **vẫn dùng được đến D+14** — không cắt ngay để có buffer chuyển đổi.

Bất kỳ blocker nào — nhắn admin @<admin>.
```

## D+0 meeting agenda (30ph)

- (5ph) Vì sao đổi: cost saving 60%+, multi-provider fallback
- (10ph) Demo live: login → chọn model → hỏi 1 câu MCP → xem citation
- (5ph) Naming convention + workspace `onelog-investigations`
- (5ph) Kill-switch scenario: khi 1 provider down thì sao
- (5ph) Q&A

Record video → upload link vào `openwebui-user-guide.md` §Support.

## D+7 usage check

```bash
# Login count 7 ngày qua (từ OpenWebUI log)
docker compose logs --since 7d openwebui | grep -i 'login' | awk '{print $NF}' | sort -u

# Chat count per user (nếu enable metric)
curl -fsS http://webui.local/api/v1/usage -H "Authorization: Bearer <admin-token>"
```

Ai < 1 chat/tuần → 1-1 onboarding 15 phút.

## D+14 Claude Desktop revoke

- Chỉ revoke MCP token của ai đã ≥ 5 chat trên OpenWebUI (chứng minh migrate xong).
- Ai chưa → giữ token thêm 1 tuần + escalate manager.
- Revoke command:
  ```bash
  cd ~/onelog/infra
  vi .env    # xóa dòng MCP_BEARER_TOKENS_<user> hoặc rotate
  docker compose --profile mcp restart mcp-vl mcp-semantic
  ```

## D+21 escalation

Nếu vẫn < 5/5 active:
- Gửi report team lead: ai chưa migrate, lý do, blocker.
- **Không tự động delay** — team lead quyết định force cutover hoặc extend chính thức.

## D+30 post-mortem template

```markdown
# Post-mortem — OpenWebUI migration D+30

## Cost saving thực tế
- Baseline Claude (30 ngày trước cutover): $X / VND Y
- Actual (30 ngày sau cutover): $A / VND B
- % saving: (Y-B)/Y * 100 = ?%
- Target: ≥ 60%. Đạt / Miss vì lý do...

## Adoption
- 5/5 active daily / 4/5 / 3/5 / ...
- Ai chưa dùng, vì sao

## Incident
- 0 / N incident. Loại: ...

## What worked
- ...

## What didn't
- ...

## Next
- Giữ Claude Desktop path hay xóa?
- Enable Postgres backend cho LiteLLM?
- OIDC integration?
```

## Rollback trigger (during migration)

Rollback về Claude Desktop only nếu:
- **> 2 incident/tuần** liên quan LiteLLM proxy (crash, wrong response)
- **Cost thực > 150%** baseline Claude (nghĩa là đổi mà đắt hơn)
- **> 3/5 ops** báo blocker không fix trong 1 tuần

Rollback steps: xem [deployment-llm-abstraction.md](../../docs/deployment-llm-abstraction.md) §Rollback.

## Unresolved

1. Phase 4 benchmark chưa chạy — chọn default model tạm là `claude-sonnet` (an toàn) hay `gemini-flash` (rẻ)?
2. Provider key ai giữ backup offsite? — hiện chỉ có trong `.env.llm` server.
3. Có cần record video demo D+0 không, hay live-only?
