# Brainstorm — OneMCP Skills workflow & pilot skill

**Date:** 2026-07-27 16:39
**Topic:** Cách thêm skill mới trên OneMCP + recommend portfolio theo phòng

## Problem statement

User (non-Git, đại diện đa phòng) muốn hiểu workflow thêm skill trên OneMCP + có skill đầu tiên khả dụng để pilot.

## Workflow hiện tại (as-is)

Git-driven, KHÔNG có UI upload:

1. Dev viết `skills/<name>/manifest.json` + `SKILL.md` trong repo `onemcp/skills-kythuat`
2. Push → GitLab webhook / cron / manual `POST /skills/sync` trigger sync
3. `SkillSyncService` walk mirror → parse manifest (Zod) → tạo `SkillVersion(status='pending')`
4. Maintainer/admin cùng dept approve UI → `status='active'` + set `currentVersionId`
5. MCP client `load_skill(name)` trả body markdown → LLM đọc

**Ràng buộc**:
- `permissions: ['read']` hardcoded — không execute, static markdown
- Version unique per `skillId + commitSha`
- Search chỉ trả `status='active'` version

## Gap phát hiện

1. **Non-tech dept (marketing/sale) không dùng được Git flow** — bottleneck onboarding
2. **Không có preview trước approve** — reviewer chỉ thấy raw SKILL.md
3. **Search skill body_search chỉ index `body`** — tag không match free-text search (đã note ở brainstorm search trước)

## Approaches evaluated (fix non-tech gap)

| Option | Approach | Pros | Cons |
|---|---|---|---|
| A | Tech scribe cho non-tech | 0 dev effort, giữ Git canonical | Bottleneck maintainer |
| B | Portal skill editor form | UX consistent với KB, non-tech tự làm | Mất single-source Git, ~2-3 ngày dev |
| C | Chat action `🎓 Save as Skill` | Zero-friction reuse pattern KB | LLM extract chất lượng phập phồng, ~2 ngày dev |

**Quyết định user**: Chưa fix gap, pilot phòng KT trước.

## Skill portfolio recommend

**KT vận hành server** (fit design nhất): `nginx-502-troubleshoot`, `crowdsec-bouncer-triage`, `postgres-slow-query-triage`, `docker-oom-postmortem`, `onelog-vps-deploy-runbook`, `certbot-renewal-failure`.

**Marketing**: `brand-voice-onelog`, `blog-seo-template`, `campaign-brief-template`, `competitor-analysis-framework`.

**Sale**: `objection-handling-playbook`, `product-pitch-onelog`, `pricing-tier-explainer`, `qualifying-questions-bant`, `demo-script-standard`.

**Cross-dept**: `incident-postmortem-template`, `meeting-notes-format`, `okr-writing-guide`.

## Chốt phase 1

- **First skill**: `nginx-502-troubleshoot`
- **Path unblock**: Y — draft trong `plans/260727-1639-skill-nginx-502-draft/` (không đợi Git access)
- **Deliverable**: `manifest.json` + `SKILL.md` với 6-step diagnostic + root cause table + escalate note

## Next steps

1. ✅ Draft `manifest.json` + `SKILL.md` (done, xem plan folder)
2. ⏳ User xin Git access repo `onemcp/skills-kythuat` (Developer role)
3. ⏳ User copy 2 file sang skills-kythuat, push branch, tạo MR
4. ⏳ Trigger sync + approve qua portal
5. ⏳ Test MCP `load_skill('nginx-502-troubleshoot')` từ Claude Desktop
6. ⏳ Feedback 1 tuần từ team KT
7. ⏳ Viết skill thứ 2: `crowdsec-bouncer-triage` (dùng KB pending làm base)
8. ⏳ Sau 3-5 skill có traction → design non-tech onboarding (Option B/C)

## Success metrics

- Skill đầu xuất hiện portal + search hit keyword "502" / "nginx"
- MCP `load_skill` trả full body markdown < 500ms
- ≥ 2 lần incident 502 team KT reference skill trong 2 tuần đầu
- Refine version bump (0.1.0 → 0.2.0) trong 4 tuần đầu = signal skill sống

## Risks

- **Git access ticket bị delay** → mitigate bằng Path Y (draft sẵn, chờ push)
- **Skill nội dung outdated nhanh** → cần owner rõ ràng, version bump khi stack đổi
- **Team KT không đọc skill khi ops** → cần integrate skill vào flow chat OpenWebUI mặc định

## Unresolved questions

- Stack edge dùng nginx hay Caddy? SKILL.md hiện assume nginx — nếu Caddy cần rework Bước 5
- Ai là maintainer OneMCP hiện tại (người approve skill version)? User cần liên hệ để nhờ approve khi push
- Sync trigger — cron interval hiện là bao nhiêu? Ảnh hưởng thời gian skill lên pending
- Có manifest CI validate trong repo skills-kythuat chưa, hay chỉ runtime validate?
