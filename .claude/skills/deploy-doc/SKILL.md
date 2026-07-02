---
name: deploy-doc
description: "Write or rewrite a deployment guide (`docs/deployment-*.md`) in the OneLog concise playbook style — golden rules up top, copy-paste quick deploy blocks, config .env, verify checklist, troubleshooting table, rollback, unresolved. Activate when user asks to write/update/rewrite a deploy/deployment doc, or convert a plan into a deploy runbook."
metadata:
  author: vietnt
  version: "1.0.0"
---

# Deploy Doc — Playbook Writer

Produce copy-paste-runnable deployment docs. Ops engineer pulls latest, opens the doc, follows blocks top-to-bottom, done in ~15 minutes for the common case. Zero prose fluff.

## When to run

- **Manual triggers:** "viết doc deploy", "update deployment guide", "rewrite deployment-X.md", "convert plan phase 5 to deploy runbook", "làm file deploy cho X".
- **Post-cook:** khi Phase deploy hoàn tất và cần doc cho ops team pull + follow.
- **After actual deploy:** khi thu được lessons từ deploy thực → consolidate vào doc.

## Reference exemplars

Follow these files as templates (both in `docs/`):
- `deployment-guide.md` — base stack (rag-logserver)
- `deployment-llm-abstraction.md` — LLM stack (Phase 1-3 plan 260701-1544)

If user asks for a new deploy doc, mirror this structure — do not invent new sections.

## Structure (mandatory sections in order)

```
# Deploy <Component> (short subtitle)

> 1-2 line context · plan ref · verify status

## Golden rules
  4-6 numbered gotchas (path, profiles, secrets, order dep, re-login, etc.)

## Topology (optional)
  ASCII diagram — only if adding services / changing network

## Quick deploy — <target>
  Copy-paste block 5-8 steps. Each step = 1-3 shell commands + inline verify.
  Assumption: user has provider keys / secrets ready. If not, note explicitly.

## Config .env
  Exact env block to paste — no placeholders like <secret>, use `<paste>` marker.

## Bootstrap steps (if applicable)
  Admin account / initial data seed. Include lock-back procedure.

## Verify checklist
  4-6 curl / docker commands showing expected output.

## Backup (if applicable)
  keypair gen + cron 3-liner. Note offsite storage requirement.

## Troubleshooting
  Markdown table: Symptom | Fix.
  Include ONLY errors seen in real deploys — no speculative ones.

## Update secrets / config (post-deploy)
  How to rotate keys / change model / redeploy narrow scope.

## Rollback
  Full rollback (git checkout + compose rebuild) + partial (env flip + restart).

## Post-deploy
  Ops checklist: systemd unit update, offsite backup, monitoring wire-up.

## Unresolved / defer
  Numbered list of decisions punted. Answer key: what, why deferred, trigger to revisit.
```

## Writing rules

1. **No story-telling.** Command block > 3 lines of prose. Prose only for context that can't be shown in a command.
2. **All command blocks copy-paste runnable.** No `<placeholder>` inside code — either concrete values or `$VAR` from `.env` shown earlier.
3. **Every troubleshooting row must be from actual deploy experience.** If speculative, cut it. Doc grows only when a real symptom is observed.
4. **Golden rules earn their spot.** 4-6 max. Each rule = a specific mistake that will bite ops if not read.
5. **Vietnamese primary, English for technical.** Sentences: VI. Commands, code identifiers, exception messages: as-is EN.
6. **Cross-link related deploy docs.** If deploy A depends on deploy B being done, link at intro + at the step where dep matters.
7. **Sacrifice grammar for concision.** "Chờ 30s" > "Bạn hãy đợi 30 giây trước khi tiếp tục".

## Anti-patterns (do NOT do)

| Bad | Reason |
|---|---|
| Long paragraphs explaining architecture | Belong in `plan.md`, not deploy doc |
| Every symptom with 3 possible causes | Only the ONE fix that worked in practice |
| Numbered sub-sections nested 3+ deep | Ops scanning fast — max 2 levels |
| "See appendix for details" | If details needed, put inline. If not needed, cut |
| Placeholder `<your-domain>` in code blocks | Use `$APP_DOMAIN` (from .env) or `192.168.122.53` (lab) |
| Screenshot references without file paths | Either commit screenshots to `docs/images/` or drop the reference |
| Duplicate content across sections | Prefer 1 canonical location + link |

## Length targets

- Sub-100 line doc → too thin, missing verify/troubleshoot/rollback
- 200-350 lines → healthy range
- Over 500 lines → split into 2 docs (e.g., ops guide + user guide)

## Process

1. **Scout inputs.**
   - Existing plan file (`plans/YYYYMMDD-NNNN-*/phase-*.md`) — pull effort, risks, decisions.
   - Real deploy transcript (if available) — every error encountered → troubleshoot row.
   - Current stack state (`docker compose ps`, `.env.example` in repo) — check paths + service names match.

2. **Confirm scope.**
   - What component / plan does this doc cover?
   - Who is the target: ops team, dev, external SRE?
   - Full deploy from scratch, or delta on top of existing stack?

3. **Draft in structure order.** Fill each mandatory section. Skip topology if no new services.

4. **Dedupe against sibling docs.** If a step is identical to another deploy doc, link instead of duplicate.

5. **Length check.** Trim any section > 40% of file total.

6. **Verify code blocks.**
   - All paths resolve (e.g., `~/onelog/infra` not `/opt/onelog`)
   - All service names match `docker-compose.yml`
   - All env vars exist in `.env.example`
   - All `--profile` flags match compose file profile assignments

7. **Cross-link.** Add 1-2 links to related deploy docs (base stack, LLM stack, etc.).

8. **Commit.** Message: `docs(deploy): <verb> <target>` — e.g. `docs(deploy): add postgres HA guide`, `docs(deploy): rewrite deployment-guide.md as concise playbook`.

## Output location

- **File path:** `docs/deployment-<slug>.md` (e.g., `deployment-llm-abstraction.md`, `deployment-ha-postgres.md`)
- **NEVER** create outside `docs/` per project rules
- **NEVER** duplicate `deployment-guide.md` — always rewrite in-place

## Example prompts that trigger this skill

- "Viết doc deploy cho phase 3 openwebui"
- "Update deployment-guide.md theo pattern mới"
- "Convert plan 260701-1544 phase 5 thành runbook ops"
- "Consolidate lỗi deploy hôm nay vào doc"
- "Rewrite deployment doc gọn hơn, copy-paste được"

## Non-goals

- Not for design docs, architecture explainers, or PDR files → those go in `docs/*-pdr.md` or `plans/`
- Not for user-facing product guides → those go in `docs/*-user-guide.md` with more prose + screenshots
- Not for API references → those live in code (docstrings, OpenAPI schemas)
