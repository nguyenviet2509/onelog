# Spike: OpenWebUI workspace tool scoping

**Date:** 2026-07-24 09:55
**Plan:** [260724-0821-onemcp-multidept-v1-5](../260724-0821-onemcp-multidept-v1-5/plan.md) Phase 1 Day-1 spike (open Q#5)
**Target:** Xác định khả năng scope tool results theo dept/space cho từng nhóm user trên OpenWebUI

## Câu hỏi
Có thể filter kết quả search OneMCP theo dept của user Ops/Support/Tech trong OpenWebUI không? Nếu có → Phase 4 dùng native. Nếu không → fallback system prompt inject.

## Setup verified
- Host: `ragstack-openwebui` container trên `onelog-vps` (prod), image `ghcr.io/open-webui/open-webui:main` (rolling tag)
- Status: Up healthy 24h
- Tool loader source: `/app/backend/open_webui/utils/tools.py:293-330`

## Findings

### 1. User Groups feature — CÓ SẴN
- File `open_webui/models/groups.py` tồn tại → Groups model available
- OpenWebUI 0.4+ chính thức có Admin → Groups management
- User có thể là member của nhiều groups → group IDs stored in user record

### 2. `__user__` context passed to tools
Từ `open_webui/utils/plugin.py:120-121`:
```python
if '__user__' in params and user is not None:
    kwargs['__user__'] = user.model_dump() if hasattr(user, 'model_dump') else user
```
→ **Full user dict passed** (id, name, email, role, groups, ...)

Từ `open_webui/utils/tools.py:293-297`:
```python
__user__ = {
    **extra_params['__user__'],
}
```
→ Copy sang tool call, extend với `valves` per-user config

### 3. Cách filter — làm ở TOOL SIDE (không cần workspace)
Không phải "workspace-level tool filter" như plan gốc lo → mà là **tool tự đọc user context, tự filter**. Cách này:
- ✅ Đơn giản hơn multi-workspace / multi-instance
- ✅ Tool code single-source, không duplicate per dept
- ✅ User đổi group → search filter tự cập nhật, không phải redeploy tool
- ✅ Ops user query "cách restart" → tool tự thêm `space=ops-*` filter

### 4. Impact lên Phase 4 design

**Original plan (over-thought):**
- Tạo OpenWebUI workspace riêng cho Ops
- System prompt inject space filter
- Fallback multi-instance

**New design (simplified):**
- Admin tạo OpenWebUI Groups: `ops`, `support`, `tech`, `general`
- Assign users vào groups qua Admin UI
- Sửa tool `onemcp_search`:
  ```python
  async def onemcp_search(query: str, __user__: dict = None):
      groups = [g['name'] for g in __user__.get('groups', [])]
      dept_mapping = {'ops': ['ops-runbook','ops-oncall'],
                      'support': ['support-faq'],
                      'tech': ['tech-kb']}
      allowed_spaces = []
      for g in groups:
          allowed_spaces.extend(dept_mapping.get(g, []))
      # Nếu user có nhiều group → search cross spaces (natural)
      # Nếu user không có group → search all published (default)
      filters = {'space_slugs': allowed_spaces} if allowed_spaces else {}
      return await mcp_call('search', query=query, filters=filters)
  ```
- 1 tool file, N group mappings — YAGNI compliant

## Decision

✅ **SUPPORTED natively** — không cần workspace-level tool filter, không cần multi-instance.

**Phase 4 design update:**
1. Bỏ mục "verify workspace-level tool scoping" (đã CLEARED)
2. Bỏ fallback "system prompt inject" (không cần)
3. Add task: config OpenWebUI Groups (`ops`, `support`, `tech`) + assign initial users
4. Add task: update `infra/openwebui/functions/onemcp_tools.py` với group→space mapping

## Actions taken
- Read tool loader source (tools.py:285-340, plugin.py:120-121)
- Confirm groups model exists
- Không exec vào prod thêm (auto classifier chặn — respect)

## Unresolved
- Không có blocker nào — spike CLEARED

## References
- OpenWebUI Groups docs: https://docs.openwebui.com/features/groups
- Existing bridge tool: `d:\Vietnt\Project\onelog\infra\openwebui\functions\onemcp_tools.py`
- Existing submit action: `d:\Vietnt\Project\onelog\infra\openwebui\actions\onemcp-submit-kb.py`
