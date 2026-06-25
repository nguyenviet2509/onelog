---
name: update-services-detail
description: "After every /ck:cook completes, update mockups/onelog-services-detail.html (per-service changes) AND mockups/onelog-system-explainer.html (if cook touches system-level concerns: topology, pipelines, tools, security, data model). Activate at finalize phase of cook, or when user asks to sync mockups."
metadata:
  author: vietnt
  version: "1.1.0"
---

# Update Services Detail + System Explainer

Sync 2 mockup files after each cook so they reflect what was just built:
1. `mockups/onelog-services-detail.html` — per-service catalog (always check).
2. `mockups/onelog-system-explainer.html` — high-level system model (only when system-level changes).

## When to run

- **Automatic:** Final step of `/ck:cook` finalize phase (after project-manager + docs-manager, before journal).
- **Manual:** User says "update services detail" / "sync mockup" / "update onelog-services-detail".

## Target files

### A. `mockups/onelog-services-detail.html` (per-service)
Each service lives in `<section id="{slug}">` (e.g. `victorialogs`, `qdrant`, `rsyslog`, `vector`, `nats`, `indexer`, `mcp-semantic`, `mcp-vl`, `caddy`, `vmalert`, `alertmanager`, `redis`, `postgres`, `decom`).

### B. `mockups/onelog-system-explainer.html` (system-level)
Sections by id: `topology`, `components`, `ingest`, `query`, `tools`, `workflow`, `data`, `security`, `runbook`. Plus: hero block, decommission banner, FAQ `<details>`, footer date.

**Trigger file B update when cook changes any of:**
- Topology (new VM/host, IP, ingress) → `#topology` mermaid + components table.
- Ingest pipeline (vector config, rsyslog, NATS subjects, drain3/embedding) → `#ingest` sequence + highlights.
- Query path (Claude Desktop routing, mcp-remote bridge, Caddy routes) → `#query` sequence + 3 cards.
- MCP tools added/removed/renamed → `#tools` cards + `#components` table.
- Data model (LogsQL fields, Qdrant payload, Postgres audit schema) → `#data` 3 panels.
- Security (auth, TLS, IP allowlist, audit path) → `#security` table.
- Ops workflow change → `#workflow` mermaid + cards.
- Decommission/resurrect → banner near top + FAQ entry.
- Header version chip (`v2026.06 · MCP-only`) + footer date.

**Skip file B when** cook only touches: one service's internal code without changing its public contract, bugfixes, deps bump, tests, docs only.

## Procedure

1. **Detect affected services** from the just-finished cook:
   - Read changed files (git status + diff in current branch vs master).
   - Map paths → service id (e.g. `services/mcp-vl/**` → `mcp-vl`, `infra/vmalert/**` → `vmalert`, `infra/vector/**` → `vector`).
   - Skip if no infra/service code changed.

1b. **Detect system-level impact** (decides whether file B is touched):
   - Diff includes `infra/docker-compose.yml` service block add/remove/rename → file B.
   - New port exposed / route added in `infra/caddy/**` → file B (`#components`, `#security`, `#topology`).
   - `services/mcp-*/tools.py` (or equivalent) signature change → file B (`#tools`).
   - Schema migration `infra/postgres/**` or Qdrant payload shape → file B (`#data`).
   - `docs/deployment-guide.md` / `docs/ha-roadmap.md` updated → likely file B.
   - Decommission/resurrect any service → file B banner + FAQ.

2. **For each affected service section in file A**, update in place (use Edit tool, never rewrite the whole file):
   - **Role/purpose block** (`.role`): refresh wording only if behavior changed.
   - **Files table** (`.files`): add/remove/rename config files actually touched.
   - **Reload command** (`.files .reload code`): update if reload mechanism changed.
   - **Pills/chips in `.svc-header`**: update tech stack/ports/version if changed.
   - **Pipeline/flow descriptions**: 1-2 sentences max, plain Vietnamese, no jargon dump.

3. **For file B (system-explainer)** — only if step 1b triggered:
   - Edit only the affected section(s); do NOT rewrite mermaid graphs unless topology/sequence truly changed.
   - When adding mermaid nodes/edges: copy existing node style, keep node ids short.
   - Update header chip `v2026.MM · ...` + footer date to current month.
   - If new MCP tool: add a row in `#components` table AND a card in `#tools` (mirror existing 2-card layout).
   - If service decommissioned: add `<s>strikethrough</s>` row + amber pill in `#components`, add line in banner, add FAQ entry.
   - Cite source docs in section header `<span class="mut text-xs">` if mentioning new doc.

4. **Style rules** (apply to both files):
   - Vietnamese, short sentences.
   - Reuse existing CSS classes (`card`, `chip`, `pill`, `role`, `files`, `step-num`, `h-title`). Do NOT add new styles.
   - File A: each service section under ~80 lines. File B: each section keeps current density.
   - No emojis (file B hero chips are the only exception — keep existing, don't add new).
   - Facts only. No marketing copy.

5. **What NOT to do:**
   - Do not add new `<section>` unless cook explicitly created the service / system concern.
   - Do not touch sections unaffected by the cook.
   - Do not reformat unchanged HTML (minimal diff).
   - Do not add `<!-- updated ... -->` comments.
   - Do not regenerate the whole mermaid block for a 1-node change — patch the specific line.

6. **Verify both files:**
   - Balanced tags (`<section` count == `</section>` count).
   - File A: no broken `.svc-nav` anchors.
   - File B: TOC `<ol>` anchors still resolve.
   - Mermaid blocks: no dangling arrows.

## Output

End with one line:
```
✓ mockups synced — A(services-detail): [svc1, svc2] | B(system-explainer): [#topology, #tools] OR skipped
```

## Skip conditions

- Cook only changed docs/, plans/, mockups/, or tests → skip both files.
- No `infra/`, `services/`, `apps/` changes → skip file A.
- No system-level signals (see step 1b) → skip file B only.
