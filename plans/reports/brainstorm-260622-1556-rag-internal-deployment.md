---
type: brainstorm
date: 2026-06-22 15:56
slug: rag-internal-deployment
related_plan: plans/260622-1056-rag-logserver-victorialogs
---

# Brainstorm — RAG Log Server Internal Deployment Context

## Problem
Deploy RAG log server cho phòng kỹ thuật nội bộ. Truy cập qua VPN (OpenVPN). Domain + SSL công ty cấp sau. Có thể tích hợp API các hệ thống nội bộ khác (Jira/GitLab/Zabbix/CMDB) — chưa chốt priority.

## Constraints
- Audience: 5-20 sysadmin/dev nội bộ, tin cậy
- Network: VPN-only, không expose public
- Domain + SSL: defer (sysadmin/network team cấp)
- Internal API integration: defer (chưa chốt priority)
- LLM egress (Anthropic/OpenAI): chưa biết direct hay proxy → app phải proxy-aware
- Auth per-user: defer cùng SSO sau MVP

## Approaches Evaluated

### A. Tự lo toàn bộ infra ngay từ MVP (DNS, LE cert, OIDC SSO, internal API)
- Pros: production-ready end-to-end
- Cons: block bởi external dependencies (network team, DNS, IdP), trễ 2-3 tuần
- Reject: vi phạm YAGNI, block work

### B. Defer infra, focus application layer; thêm placeholder + interface
- Pros: unblock dev ngay, infra concerns ghi rõ trong checklist deployment
- Cons: cần discipline để không drift khỏi assumption
- **Choose**

### C. Local-only dev, ignore deployment context
- Pros: nhanh nhất
- Cons: app code không proxy-aware, không có tool registry → rework lớn sau
- Reject: tech debt cao

## Final Solution (Approach B)

### Deployment context (ghi nhận, defer execution)
- Domain `rag.<corpdomain>` — sysadmin tạo A record IP private khi sẵn sàng
- TLS — sysadmin cấp cert (LE DNS-01 hoặc internal CA), Caddy mount cert file
- Network — UFW + Caddy whitelist VPN CIDR (placeholder, fill khi network team confirm)
- Backup offsite — NAS/MinIO path placeholder

### Application-layer changes (do ngay)

**Phase 03 (RAG agent) enrich:**
1. **LLM client proxy-aware**: dùng `httpx.AsyncClient` respect env `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` cho Anthropic + OpenAI SDK. Swap proxy zero code change.
2. **Internal tool registry interface**: scaffold `tools/external/` dir + registry pattern. Stub adapters cho `jira`, `gitlab`, `metrics`, `cmdb` — return `{"status": "not_configured"}`. Wire thật ở Phase 03.5 sau.
3. **Audit minimal**: session_id + tool calls + tokens (đã có). User_id = `"anonymous"` cho đến khi plug auth.

**Phase 04 (Web) enrich:**
- Banner header "Internal use — VPN required" để user aware
- Không cần login page MVP (đã defer)

**Plan-level:**
- Add Phase 03.5 stub: "Internal API adapters" — scope sau khi confirm priority
- Add Phase 09 stub: "SSO + per-user audit" — sau MVP

### Skip (defer to company-provided)
- Caddy TLS config thật (giữ stub `tls internal` hiện tại)
- DNS provider module Caddy
- UFW VPN CIDR rule (doc placeholder)
- Backup offsite target

## Implementation Notes
- httpx proxy-aware: Anthropic SDK accepts `http_client` param → inject custom client
- Tool registry: dict `name → callable`, mỗi tool có schema JSON cho LLM tool-use
- External tool stubs có cùng interface internal tools → Phase 03.5 chỉ implement body, không sửa graph

## Success Metrics
- App chạy local + dev VM mà không hardcode domain/proxy/internal-API endpoint
- Swap proxy via env → LLM call work không restart code
- Phase 03.5 trigger được khi sysadmin confirm priority + provide credential, không phải refactor

## Risks
- Network team trễ → app sẵn sàng nhưng không deploy được. Acceptable, dev VM local ổn.
- VPN compromise + no auth → mọi user VPN xem hết. Mitigation: doc rõ rủi ro + push Phase 09 SSO sớm sau MVP.
- Tool registry pattern over-engineer nếu chỉ 1-2 tool ever → giữ KISS, không build plugin system; chỉ là dict + interface.

## Next Steps
1. Update `plan.md` Context section ghi deployment internal/VPN/domain-defer
2. Update `phase-03-rag-agent-service.md`:
   - Step thêm: httpx proxy-aware LLM client
   - Step thêm: external tool registry stub
   - Files thêm: `agent/src/agent/tools/external/{registry,jira_stub,gitlab_stub,metrics_stub,cmdb_stub}.py`
3. Add row Phase 03.5 + Phase 09 vào bảng phases (status pending, no detail file yet)

## Unresolved Questions
- DNS provider của corp domain (cho LE DNS-01 sau)
- OpenVPN client subnet CIDR
- LLM egress direct vs proxy URL
- Internal API priority order (Jira/GitLab/Metrics/CMDB)
- Backup offsite target (NAS path hoặc MinIO endpoint)
- SSO method khi plug Phase 09 (Keycloak/Azure AD/Google Workspace)
