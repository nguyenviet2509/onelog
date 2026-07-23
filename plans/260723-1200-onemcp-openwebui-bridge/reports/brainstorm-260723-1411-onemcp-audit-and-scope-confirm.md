# Brainstorm — OneMCP audit + scope confirm cho OneLog integration

**Date:** 2026-07-23 14:11 (Asia/Saigon)
**Owner:** trihd@inet.vn
**Status:** Approved — plan không đổi scope, chỉ tweak Phase 3
**Related:**
- Plan: `plans/260723-1200-onemcp-openwebui-bridge/`
- Previous brainstorm: `plans/reports/brainstorm-260723-1200-onemcp-openwebui-bridge.md`

## Trigger
User trình bày lại full vision OneMCP (dept MCP server, SSO, RBAC, artifacts + skills contribute, template-driven AI writing). Yêu cầu đọc lại OneMCP + quyết định đúng scope OneLog dev.

## OneMCP audit findings

### Đã ship (P1-P7)

**Artifacts subsystem** — 5 types, template-driven:
| Type | Fields | Gating |
|---|---|---|
| `kb` | problem, solution, related | default |
| `report` | summary, incident_timeline, root_cause, remediation, action_items | default |
| `research` | question, methodology, findings, references, next_steps | default |
| `postmortem` | 4 required + 8 optional (severity, blast_radius, detection_gap, raw_logs...) | `ONEMCP_ENABLE_OPS_TYPES=1` |
| `runbook` | 6 required (service, symptoms, verify_command, mitigation_steps, verification_after, escalation_path) | `ONEMCP_ENABLE_OPS_TYPES=1` |

Template registry với validator (min/maxLength, required, type `text|markdown|logs`). Body auto-compile từ structured fields.

**MCP tools (8)** ready-to-use từ OpenWebUI:
- `search`, `get_artifact`, `list_artifacts`
- `get_artifact_template(type)` — LLM đọc để biết fields spec
- `submit_artifact(type, structured)` — validate + save pending
- `list_skills`, `load_skill` — git-synced skills
- `load_runbook` — dedicated với load event tracking

**Infra**: RBAC 5 roles, multi-tenant `department_id`, review workflow pending→published, versioning, Alertmanager P7 webhook, audit, Prometheus metrics, daily backup, MinIO attachments.

### Roadmap chưa ship (không blocking OneLog)
- INET/GitLab SSO (v2)
- pgvector semantic (P4.2)
- Portal skill contribute UI (skills contribute qua git flow thuần)

## Key insight cho AI-writes-per-template

OneMCP đã có sẵn `get_artifact_template()` — nghĩa là **KHÔNG cần code template logic bên OneLog**. Flow chuẩn:

```
LLM gọi onemcp_get_template(type)  →  nhận fields spec
LLM đọc chat transcript             →  fill vào từng field theo spec
LLM gọi onemcp_submit_artifact()   →  OneMCP validate + save
```

Nghĩa là "Instruct AI viết theo template" đã tự động — chỉ cần LLM tuân prompt gọi template trước khi submit.

## Skills contribution — out of scope

Skills = git repo `skills-kythuat` (P2 shipped). Member commit SKILL.md + push → OneMCP auto-sync `*/15 min`. **Không fit chat button pattern.** Team muốn contribute skill → dùng git flow bình thường, portal OneMCP chỉ để browse/load.

→ OneLog integration KHÔNG expose skill submit qua chat button.

## Scope confirm cho OneLog integration

User đã chốt 3 điểm quan trọng:

| Item | Decision | Rationale |
|---|---|---|
| Types trong Save button | **Chỉ `kb`** | MVP focused. KB đúng use-case chính (bug-trace reuse). Report/research/ops types defer — nếu team cần, contribute qua portal trực tiếp. |
| Skills docs | **Skip** | Không phải scope OneLog. Team OneMCP owns docs skills workflow. |
| System prompt | **LLM detect KB-worthy** trước khi nudge nút | Tránh false positive (nhắc save cho chat lan man). |

## Plan changes

**Plan `260723-1200-onemcp-openwebui-bridge` giữ nguyên** — không rework Phase 2. Chỉ tweak:

- **Phase 3 system prompt**: thêm rule LLM đánh giá "KB-worthy" (problem + solution + user confirm fix). Nếu match → nhắc button; nếu không → dừng bình thường.

## Còn lại từ user vision — không thuộc scope OneLog dev

Những điều user nêu nhưng thuộc OneMCP team ownership:
- INET/GitLab SSO integration (v2 roadmap OneMCP)
- Cross-department scaling (multi-tenant OneMCP đã có, dept mới tự onboard)
- Long-term storage + audit (đã ship)
- Skills contribution UX polish (defer, git flow đủ)
- Portal contribute artifact UI (đã có ở portal OneMCP hiện tại)

**Nếu user muốn dev bất cứ điểm nào ở trên → cần brainstorm/plan riêng trong project OneMCP (`D:\Vietnt\Project\onemcp`), không trong OneLog.**

## Unresolved
- (none) — tất cả 3 câu hỏi đã trả lời.

## Next
- Không tạo plan mới. Plan `260723-1200-onemcp-openwebui-bridge` sẵn sàng cook.
