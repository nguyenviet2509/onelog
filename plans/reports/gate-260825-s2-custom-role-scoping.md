# Gate S2 — Custom Role Scoping (GitHub #10505 Review)

**Date:** 2026-08-25  
**Issue:** [zitadel/zitadel #10505](https://github.com/zitadel/zitadel/issues/10505)  
**Status:** CLOSED

---

## Issue Summary

**Bug:** Since v4, project owners with "Project Owner" role cannot create roles in projects they own.  
**Reported on:** Zitadel v4.0.2  
**Error:** `"No matching permissions found (AUTH-Swrgg2)"`  
**Endpoint affected:** `AddProjectRole`, `RemoveProjectRole` via Management API

## Analysis

The issue is about **human users with Project Owner role** being blocked from creating project roles via Management API. This is a permissions regression in Zitadel v4.0.x.

However, our use case is a **Service Account (SA) with IAM_OWNER** — not a project owner. The SA has full IAM owner permissions, which are not affected by this bug.

**The issue is CLOSED** (assignee: kkrime) — fix was merged but the last two comments (Aug 2025) show the bug may persist for some v4.x versions for project-owner-scoped human users. The workaround documented is "go over other organization."

## Custom Role `CENTRAL_RBAC_MANAGER` Feasibility

The plan originally proposed creating a minimal custom Zitadel role for the SA. The GitHub issue #10505 reveals:

1. **Zitadel v4 has permission scoping bugs** for project-owner path — affecting non-IAM_OWNER users
2. **Our sandbox (v4.16.1)** — issue CLOSED suggests fix applied. However, creating a *custom Zitadel IAM role* with exactly the permissions needed (`iam.projects.roles.write`, etc.) requires Zitadel Console access or Zitadel System API. The Management API does not expose a "create custom role" endpoint for instance-level IAM roles.
3. **Zitadel built-in roles** are: `IAM_OWNER`, `IAM_OWNER_VIEWER`, `ORG_OWNER`, `ORG_OWNER_VIEWER`, `PROJECT_OWNER`, `PROJECT_OWNER_VIEWER` — no concept of "custom minimal role" in the IAM layer.

## Decision

**Accept IAM_OWNER for Phase 3.** Rationale:
- No API mechanism to create custom minimal scope IAM role in Zitadel v4 Management API
- Custom scoping in the plan spec referred to a Zitadel feature that does not exist at the IAM role level — it exists at the project grant level (user grants scoped to specific roles within a project)
- The SA PAT already works correctly for all needed operations (`AddProjectRole`, `AddUserGrant`, `ListUserGrants`, etc.)
- IAM_OWNER SA is isolated in a separate SA account, not a human user; blast radius is limited to Zitadel management operations

## Risk Mitigation

Per phase-03 spec F6: document in ops runbook that SA has IAM_OWNER. Add monitoring:
1. Log every outbox worker Zitadel API call at INFO level with SA identity tag
2. Alert pattern: if outbox worker calls non-whitelisted endpoints → emit `[SA-ANOMALY]` log
3. Quarterly: rotate SA PAT (key rotation runbook)
4. Phase 5 action: revisit if Zitadel adds granular API scopes via OAuth2 resource server claims

## Gate Verdict

**S2: ACCEPT IAM_OWNER** — no custom role provisioning in Phase 3. Document risk. Add monitoring rule to outbox worker.
