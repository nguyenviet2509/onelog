# System Architecture

> Cross-cutting design notes. Core stack topology lives in [README.md](../README.md) (services table + ASCII diagram). Ingest pipeline details in [codebase-summary.md](codebase-summary.md).

## Knowledge Base (OpenWebUI native, 2026-07-17)

Members save useful chat messages via OpenWebUI's built-in **Add to Note** button (sidebar Notes). Admin curates + uploads notes to a shared **Workspace → Knowledge** collection ("OneLog Runbook"). The collection is attached to the default model in OpenWebUI so it becomes a RAG source during chat.

No custom Next.js `/web` service, no Postgres, no OpenWebUI Function, no `/kb/*` endpoints. Prior custom KB (Phase 1, 2026-07-16) was removed the day after ship — see [journals/2026-07-16-kb-phase1-openwebui-pivot-shipped.md](journals/2026-07-16-kb-phase1-openwebui-pivot-shipped.md) for the pivot story, [project-changelog.md](project-changelog.md) for the 2026-07-17 removal entry.

## References

- [README.md](../README.md) — services + topology diagram
- [codebase-summary.md](codebase-summary.md) — module-by-module walkthrough
- [deployment-guide.md](deployment-guide.md) — env template + full deploy runbook
- [project-changelog.md](project-changelog.md) — recent changes
