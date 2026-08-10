# OneMCP AI Connector Hub — Brainstorm + Plan Approved

**Date**: 2026-08-05 08:52
**Severity**: Medium (scope clarification, architectural pivot)
**Component**: OneMCP core, OAuth 2.1, MCP protocol
**Status**: Blocked (waiting plan-27 OAuth setup)

## What Happened

Completed brainstorm session for OneMCP as shared AI infrastructure gateway. Shifted OneMCP role from single-project MCP server to **multi-project OAuth 2.1 Authorization Server + Skills Registry Hub**. Five key architectural decisions locked in, plan created covering 14–18 days across 5 phases. Blocker identified: Q5 domain/TLS cert requirements for Claude Desktop remote MCP Connector.

## The Brutal Truth

This is a **hard architectural pivot.** OneMCP stops being "the KT department's MCP server" and becomes "the shared OAuth broker for AI clients across all projects." That's clean — one identity provider, one portal, one rate-limit policy. But it means refactoring auth from CIDR + trust-header to OAuth 2.1 Bearer token, adding DCR (Dynamic Client Registration), multi-project skill sync, and defending a much larger attack surface.

The relief: we deferred the MCP Aggregator (downstream server routing). Path 2 keeps scope tight — registry-first, no container orchestration yet. But if 2+ projects confirm they need shared tools, we reopen that discussion, and the scope balloons.

Real tension: Q5 is a hard blocker. We don't know if Claude Desktop accepts self-signed cert on public IP or demands real domain + Let's Encrypt. If it demands cert, we can't proceed Phase 1 until TLS is sorted. This feels solvable (wildcard cert on existing infra), but worth asking now.

## Technical Details

**5 locked decisions:**

1. **OneMCP role = AI Gateway.** 5 responsibilities: OAuth 2.1 AS, MCP Streamable HTTP endpoint, multi-project skills registry (git-sync), RBAC (3-layer: project_scope + skill_visibility + user_role), portal onboarding.

2. **Downstream MCP Aggregator = DEFERRED.** No container hosting, no tool namespacing, no routing logic yet. Trigger reopen: ≥2 confirmed projects need shared tools.

3. **Skill permission = 3-layer static (no runtime approval).** project_scope ∈ {public, dept, private} + skill visibility flag (default/restricted) + user role ∈ {viewer, contributor, maintainer, dept-admin, super-admin}. Filter at `list_skills`, audit all load events. No popup consent per skill.

4. **Chain with plan-27, don't merge.** Plan-27 (gitlab-sso) makes OneMCP OAuth *client* to GitLab. Plan mew makes OneMCP OAuth *server* to AI clients (Claude Desktop, ChatGPT, Cursor). Plan-27 ships first, plan-new `blockedBy: [260727-0843]`.

5. **Path 2 (Skills-registry-first), not Path 3 (aggregator).** 70% of goal, 4–6 weeks. Path 3 (full hub) is 8–12 weeks and deferred until demand signal.

**Phases (14–18 days):**
- Phase 1: MCP Streamable HTTP + `.well-known/oauth-*` metadata (2–3 days) — **BLOCKED on Q5 TLS**
- Phase 2: OAuth 2.1 AS + DCR + consent (reuse plan-27 GitLab identity) (4–5 days)
- Phase 3: Multi-project skills registry (schema, git-sync worker, portal wizard) (4–5 days)
- Phase 4: RBAC extension + audit + rate limit (2–3 days)
- Phase 5: Rollout (staging, Claude Desktop smoke test, docs, pilot) (2 days)

**Q5 blocker:** "Does Claude Desktop accept self-signed cert on public IP (202.92.5.113) or require real domain + Let's Encrypt?" TLS cert is infra-level; no code change required, but must decide before Phase 1 kicks off.

## What We Tried

N/A — this was planning, not implementation. No dead-end attempted yet.

## Root Cause Analysis

Previous OneMCP design was monolithic and trust-header auth (CIDR-based). It worked for internal KT lab but couldn't scale to external AI clients (Claude Desktop, ChatGPT, Cursor). We needed identity protocol (OAuth 2.1), skill governance (project-scoped registry), and audit trail (tool call logging). Brainstorm identified three paths; Path 2 balances scope vs. delivery time.

## Lessons Learned

1. **Defer aggregator decision until confirmed demand.** Shipping with "we might need this in 3 months" adds 50% scope and delivery time. Better to do it when ≥2 projects actually ask.

2. **3-layer RBAC beats per-skill role matrix.** Temptation: build complex skill-permission DB. Instead: project_scope + manifest flag + user role. Simpler, auditable, easier to reason about.

3. **Chain plans, don't merge.** Plan-27 and plan-new have different goals (GitLab SSO consumer vs. OAuth provider). Both exist in same repo; reuse users/Redis/IP pivot, but keep phase files separate. Clearer to read and reason about cross-plan dependencies.

4. **Ask infrastructure questions early.** Q5 (TLS cert) is infrastructure, not code. Asking now saves us from building Phase 1 only to discover Claude Desktop rejects self-signed cert.

## Next Steps

1. **Confirm Q5 answer** (TLS cert requirement for Claude Desktop remote Connector). Ask user or test with Claude Desktop beta if available.
2. **Plan-27 must ship first.** Plan-27 owner: unlock GitLab OAuth app registration with iNET, ship OAuth identity provider.
3. **Activate plan-260805-0852.** Once plan-27 merged, change plan status from `blocked` to `pending` and kick Phase 1 research (docs-seeker: MCP Streamable HTTP transport spec 2025 + OAuth 2.1 DCR spec RFC 7591).
4. **Portal UX decision** (form vs. multi-step wizard for project onboarding). Plan mentions as optional, but good to sketch before Phase 3.

---

**Artifact locations:**
- Brainstorm report: `plans/reports/brainstorm-260805-0852-onemcp-ai-connector-hub.md`
- Plan dir: `plans/260805-0852-onemcp-ai-connector-hub/`
  - `plan.md` (overview + 5 phases)
  - `phase-01-mcp-streamable-http.md`
  - `phase-02-oauth2-1-as-dcr.md`
  - `phase-03-skills-registry.md`
  - `phase-04-rbac-audit-ratelimit.md`
  - `phase-05-rollout-pilot.md`
- Cross-reference: plan-27 updated with `blocks: [260805-0852]`
