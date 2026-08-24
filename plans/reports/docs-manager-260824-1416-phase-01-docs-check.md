# Documentation Assessment — Central RBAC Phase 1 Completion

## Verdict: **MINOR**

Phase 1 backend scaffolding (Fastify+TypeScript, DB, JWT auth, 74 tests) is foundational but pre-deployment. Adding central-rbac to docs now is premature — real impact occurs at Phase 5 (deploy) when the service becomes operational.

**Rationale:**
- Phase 1 is zero-Zitadel, zero-UI, zero-admin-facing. No user-visible behavior change.
- Service not yet deployed to `authway-vps` (Docker image not built/published).
- Deploy target (`authway-vps`) already documented in `authway-runbook.md` as Zitadel co-location, no structural change there.
- Plan & architecture captured in `plans/260821-1644-central-rbac-single-pane/plan.md` — excellent detail for dev workflow.

**Optimal timing for full docs:** Phase 5 completion (seed + deploy + OneMCP wire). At that point:
- Service is live on `authway-vps` → warrants update to `authway-runbook.md` (new container, endpoint, health check).
- JWT `permissions[]` contract locked → justify docs in system architecture.
- OneMCP integration live → document permission claim extraction in OneMCP runbook.

---

## Change Applied

**File:** `docs/authway-runbook.md`  
**Change:** 1 line addition to "Related" section (line 129)

```diff
## Related

  - `authway-architecture-endstate-guide.html` — kiến trúc 2-VPS
  - `authway-rbac-guide.html` — RBAC + config
+ - Plan central-rbac: `plans/260821-1644-central-rbac-single-pane/plan.md` (Phase 1 complete, Phase 5 deploy target)
  - Plan monitor: `plans/260821-1013-authway-vps-monitor-integration/`
  - Sync policy: `.claude/rules/host-sync-policy.md`
```

**Rationale:** Runbook maintainers can now discover the active Central RBAC plan without digging git history. Single sentence, zero structural change.

---

## Files NOT Updated (Deferred to Phase 5)

| File | Why |
|---|---|
| `README.md` services table | New service not deployable yet |
| `system-architecture.md` | No topology change (co-located on `authway-vps`) |
| `development-roadmap.md` | Central RBAC ≠ OneLog roadmap phase (separate project tracking in plan.md) |
| `deployment-guide.md` | No env vars / setup changes (auth service, not core log server) |

---

## Recommendation for Phase 5

When Phase 5 deploy completes:

1. **Update `authway-runbook.md`:**
   - Add health check for central-rbac container (`docker ps --filter name=central-rbac`)
   - Add `/health` endpoint probe example
   - Document break-glass JWT token generation (if admin needs manual bypass)

2. **Update `system-architecture.md`:**
   - Diagram: add Central RBAC box + `/v1/resolve` webhook flow from Zitadel Action
   - Note: separate DB `central_rbac` on shared Postgres instance
   - Link to `authway-rbac-guide.html` mockup

3. **Update `development-roadmap.md` (new section):**
   - Add "Central RBAC" after "OpenWebUI Actions"
   - Link Phase 1–5 status
   - Note OneMCP wire completion (Phase 5 +1d)

4. **Create `docs/central-rbac-runbook.md` (optional, only if needed for Phase 2-4 ops):**
   - Minimal at first — reuse plan.md for now
   - Flesh out when break-glass rotation or token refresh ops emerge

---

## Unresolved Questions

None. Plan is complete and well-documented. One deferred item only: public domain + Sectigo cert awaiting user provision (Unresolved #2 in plan).

---

**Status:** DONE  
**Summary:** Added discovery link in authway-runbook.md (1 line). Full docs deferred to Phase 5 deploy when service becomes operational.
