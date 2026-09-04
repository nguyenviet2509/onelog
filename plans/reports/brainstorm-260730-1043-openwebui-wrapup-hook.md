# Brainstorm — OpenWebUI Session Wrap-up Hook

**Date:** 2026-07-30 10:43
**Status:** Approved (Approach A)
**Slug:** `openwebui-wrapup-hook`
**Related:**
- Plan `260724-0821-onemcp-multidept-v1-5` (spaces + templates foundation)
- Report `brainstorm-260727-0843-onemcp-gitlab-sso.md` (auth prerequisite)
- Report `brainstorm-260730-0854-strategic-roadmap-onelog-onemcp.md` (Tier positioning)

## Problem statement

Nhân sự chat với AI trong OpenWebUI để troubleshoot, brainstorm, làm task. Xong session → kiến thức bay theo chat log. Đã có button 📚 submit KB (`onemcp-submit-kb.py`) nhưng phải user chủ động → 90% session user quên → KB corpus mỏng, RAG kém, cùng lỗi bị fix lại nhiều lần.

Chỉ template `kb` deployed. `report / research / postmortem / runbook` có endpoint nhưng chưa luồng dùng.

Rule checklist #9 ("luôn viết report/research/KB trước khi kết thúc phiên") hiện chỉ là rule giấy, không có mechanism enforce.

## Requirements

**Functional:**
- Trigger: Action button "End & Save" cạnh button 📚 (user explicit click)
- Support 3 artifact types: KB (đã có), Report (mới), Research (mới)
- LLM tự classify type từ transcript → không cần user chọn thủ công
- Gatekeeper strict — reject session <5 msg technical, chit-chat, không có concrete outcome
- User review + edit draft inline trước khi submit (giữ UX submit-kb hiện tại)
- Reuse `redact.py` hard/soft cho PII

**Non-functional:**
- KISS: 1 Action file mới, reuse 90% code `onemcp-submit-kb.py`
- DRY: prompt classifier + extractor tách module riêng `wrapup-prompts.py`
- Auditable: log wrapup attempts vào OneMCP audit stream
- YAGNI: không auto-detect end (Filter outlet), không auto-publish, không postmortem/runbook templates

## Approaches evaluated

### A — Single Action, LLM classify ⭐ CHOSEN
1 button `[🏁 End & Save]` → LLM classify (kb|report|research|SKIP) → fetch template tương ứng → extract fields → gatekeeper → preview → submit.

**+** Toolbar gọn, LLM đủ thông minh classify, reuse code cao.
**−** Classify sai → user phải sửa (mitigate: type badge + 1-click switch).

### B — 3 nút riêng (`📚 KB / 📝 Report / 🔬 Research`)
**+** Explicit control, không phụ thuộc LLM.
**−** Toolbar rối, 3 file Action tương tự → DRY violation.

### C — 1 nút + dropdown
**+** Balance A và B.
**−** OpenWebUI Action API không support dropdown natively.

## Recommended solution (Approach A)

### Architecture

```
User chat → OpenWebUI toolbar
                ↓
        [🏁 End & Save]
                ↓
        Redact hard/soft (redact.py)
                ↓
        Classifier LLM call
        "kb | report | research | SKIP"
                ↓
        ┌───── SKIP ─────┐
        │  Toast: "chưa  │
        │  đủ để save"   │
        └────────────────┘
                ↓
        Fetch template (get_artifact_template)
                ↓
        Extractor LLM call (prompt per type)
                ↓
        Gatekeeper strict check
                ↓
        Preview draft inline + type badge
                ↓
        User edit / confirm / cancel
                ↓
        submit_artifact MCP call
                ↓
        Toast + inline citation + audit log
```

### Files to create/edit

| File | Action | Notes |
|---|---|---|
| `infra/openwebui/actions/onemcp-wrapup.py` | NEW | Action chính, reuse pattern `onemcp-submit-kb.py` |
| `infra/openwebui/actions/wrapup-prompts.py` | NEW | classifier + 3 extractor prompts (module DRY) |
| `onemcp/backend/src/artifacts/templates/template-validator.ts` | EDIT | thêm Zod schema report + research |
| `onemcp/backend/src/db/migrations/172xxxxxxx-seed-report-research-templates.ts` | NEW | seed 2 template mới |
| `onemcp/backend/src/mcp/tools/get-artifact-template-handler.ts` | EDIT | expose report/research |
| `docs/openwebui-user-guide.md` | EDIT | section wrapup |
| `mockups/onelog-onemcp-bridge-workflow.html` | EDIT | flow wrapup |

### Template schemas

**Report:**
```
title, slug, structured: { context, work_done, outcome, next_steps }, tags
```

**Research:**
```
title, slug, structured: { question, hypothesis, findings, references, conclusion }, tags
```

### Prompts (skeleton)

**Classifier:**
- Input: last N msg transcript (redacted)
- Output: JSON `{type: "kb"|"report"|"research"|"SKIP", confidence: 0-1, reason: str}`
- Rules: SKIP if <5 technical msg, no concrete finding/fix, chit-chat

**Extractors** (3 riêng biệt, dynamic dựa type):
- KB extractor: reuse prompt hiện tại từ `onemcp-submit-kb.py`
- Report extractor: focus vào work_done + outcome
- Research extractor: focus vào hypothesis + findings

### Gatekeeper rules (strict)
- Session ≥5 technical msg
- Có concrete outcome (fix/finding/decision), không chỉ hỏi lý thuyết
- Extract có đủ required fields của schema
- Body length ≥ min threshold theo type (KB:200, Report:150, Research:300)

## Risks & mitigation

| Risk | Mitigation |
|---|---|
| LLM classify sai type | Type badge trong preview, 1-click switch type dropdown |
| Gatekeeper quá strict → user frustrate | Log rejection reason + rate; nới threshold nếu >70% reject sau 2 tuần |
| Duplicate artifact (📚 và 🏁 cùng session) | Backend check slug uniqueness (đã có); warning "artifact tương tự tồn tại" |
| PII leak | Reuse `redact.py` hard/soft proven |
| Prompt drift theo LLM model | Pin model cho classifier (deepseek fast); test suite prompt regression |

## Success metrics (đo sau 4 tuần deploy)

- ≥40% session có ≥5 technical msg sinh wrapup attempt
- ≥60% attempt pass gatekeeper → thành draft
- ≥80% draft được user submit (không bỏ)
- Report/Research count ≥5/tuần (từ 0 hiện tại)
- KB submit rate: baseline vs post-deploy (kỳ vọng +50%)

## Effort estimate

- Backend (templates + validator + seed): 1 ngày
- Action file + prompts module: 2 ngày
- Testing + tuning gatekeeper: 1-2 ngày
- Docs + mockup update: 0.5 ngày
- **Total: ~4-5 ngày 1 dev**

## Out of scope (defer to V2)

- Filter outlet auto-detect end-of-session (risk false-positive, chờ Action button đủ adoption)
- Postmortem + Runbook templates (chờ incident thật để design)
- Auto-publish (skip review) — giữ human-in-loop
- Multi-artifact per session (VD 1 session sinh cả report + kb) — chờ dữ liệu thực tế

## Dependencies

- OneMCP backend v1.5 spaces/templates (đã ship)
- MCP tool `submit_artifact` (đã có)
- OpenWebUI bridge private LAN + trust header (đã deploy)
- **KHÔNG** phụ thuộc SSO — hoạt động với identity claim hiện tại

## Next steps

1. Confirm approach → tạo implementation plan qua `/ck:plan`
2. Plan phases đề xuất:
   - Phase 1: Backend templates (report + research schema + seed + validator)
   - Phase 2: Prompts module + local test transcript
   - Phase 3: Action file + integration test bridge
   - Phase 4: Docs + mockup + rollout announcement
3. Deploy lên `onelog-source` test 1 tuần → prod

## Unresolved questions

- Model nào dùng cho classifier: deepseek (nhanh, rẻ) hay Claude (chính xác hơn)? → cần benchmark sau
- Threshold min body length cho Report/Research có nên configurable per-space không? → default trước, thêm config sau nếu cần
- Có cần i18n prompt (VN vs EN transcript) không? → hiện chat VN 80%, prompt VN + auto-detect
