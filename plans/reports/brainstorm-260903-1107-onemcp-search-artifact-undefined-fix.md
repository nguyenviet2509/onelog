# OneMCP — Search click → `/artifacts/undefined` (500) — brainstorm

**Date:** 2026-09-03 11:07 (Asia/Saigon)
**Repo:** onemcp (cross-project cook từ session onelog)
**Scope:** backend + portal — bug fix + cosmetic gap fill

## Problem

Trên `oneconnector.000nethost.com/search`, khi user query (mode default = **hybrid**) → click result → điều hướng tới `/artifacts/undefined` → `/api/artifacts/undefined` trả **HTTP 500 `Internal server error`**.

Screenshot bổ sung: card kết quả không hiển thị **title** (chỉ thấy snippet + tags), không thấy badge kind.

## Root cause (100%, không cần SSH)

Contract mismatch giữa backend `hybrid()` return và frontend `SearchHit`.

**Backend** [search.service.ts:46-59](../../onemcp/backend/src/search/search.service.ts) `HybridSearchHit`:
```
artifactId, versionId, title, slug, templateKey, spaceId, tags, snippet,
source, ftsRank, vectorRank, rrfScore
```

**Frontend** [portal/lib/api/search.ts:3-12](../../onemcp/portal/lib/api/search.ts) `SearchHit`:
```
kind, id, name, slug, snippet, tags, rank, meta
```

**Điểm nổ** [search/page.tsx:49-51](../../onemcp/portal/app/(shell)/search/page.tsx):
```ts
const itemLink = hit.kind === 'skill'
  ? `/skills/${encodeURIComponent(hit.name)}`
  : `/artifacts/${hit.id}`;   // hit.id === undefined
```

Response `mode=hybrid|fts|semantic` không có `id` (chỉ `artifactId`) → URL `undefined`. Cùng lúc `hit.name` (thật ra là `title`) và `hit.kind` cũng undefined → title trống, kind badge trống.

**Consumer nào bị:**
| Endpoint | Consumer | Field đọc | Status |
|---|---|---|---|
| MCP tool `search-tool-handler.ts:46-49` | Claude Desktop / clients | `artifactId`, `title`, `source`, `rrfScore` | ✅ OK |
| HTTP `/search?mode=…` | portal search page | `id`, `name`, `kind` | ❌ BUG |
| HTTP `/saved-searches/:id/run` | portal saved-searches replay | `id`, `name`, `kind` | ❌ **BUG THỨ 2** (cùng root cause) |

Nhánh legacy FTS `/search` (không có mode) không bị vì `SearchService.search()` return shape đúng.

## Approaches evaluated

### Option A — Adapter tại HTTP controller layer *(chọn — bản +)*
- Helper `hybridToSearchHit(HybridSearchHit) → SearchHit`
- Wrap output ở `SearchController.runHybrid()` + `SavedSearchesService.run()`
- Không đụng `hybrid()` service → MCP tool nguyên vẹn

**+ (bonus):** Thêm `av.updated_at`, `av.version_no` vào SQL hydrate → fill 2 field `meta.updatedAt`, `meta.versionNo` UI đã ready hiển thị (line 80-81) nhưng đang trống.

### Option B — Frontend nhận cả 2 shape (union type)
Loại: logic phân nhánh client, contract vẫn 2 shape, `saved-searches.ts` type cũng phải union.

### Option C — Đổi shape `hybrid()` sang `SearchHit`
Loại: break MCP tool handler (đọc `artifactId`, `title`, `source`, `rrfScore` trực tiếp text output).

## Recommended: **Option A+**

**Files touch:**
1. **NEW** `backend/src/search/hybrid-to-search-hit.ts` (~30 LOC) — adapter + spec
2. **EDIT** `backend/src/search/search.controller.ts` — wrap `runHybrid` return
3. **EDIT** `backend/src/saved-searches/saved-searches.service.ts` — wrap `run` return, đổi type `HybridSearchHit[]` → `SearchHit[]`
4. **EDIT** `backend/src/search/search-artifact-hydrate.ts` — 2 SQL SELECT thêm `av.updated_at`, `av.version_no`; map vào adapter meta
5. **NEW** `backend/src/search/hybrid-to-search-hit.spec.ts` — unit test
6. **(optional)** smoke e2e cho 2 HTTP endpoint

**Không cần:** migration DB, breaking API, đụng MCP handler.

## Adapter mapping

```ts
{
  kind: 'artifact',
  id: h.artifactId,
  name: h.title,
  slug: h.slug,
  snippet: h.snippet,
  tags: h.tags,
  rank: h.rrfScore,
  meta: {
    source: h.source,
    rrfScore: h.rrfScore,
    ftsRank: h.ftsRank,
    vectorRank: h.vectorRank,
    versionId: h.versionId,
    spaceId: h.spaceId,
    templateKey: h.templateKey,
    updatedAt: h.updatedAt,   // A+ bonus
    versionNo: h.versionNo,   // A+ bonus
  },
}
```

Extend `HybridSearchHit` type + hydrate SQL để carry `updatedAt`/`versionNo`.

## Risks & mitigation

| Risk | Mitigation |
|---|---|
| Regression MCP tool | Adapter ở controller, không đụng `hybrid()` — MCP path độc lập |
| SQL cột mới sai kiểu | TypeORM raw query → cast ISO string cho `updated_at`; test unit + smoke |
| Cache stale response | Không có cache HTTP; frontend fetch mới mỗi request |
| Deploy sai commit | Build local, tag rõ, push → onemcp-vps `git reset --hard origin/master` |

## Success criteria

1. Search `502` mode=hybrid/fts/semantic → click → mở đúng `/artifacts/{uuid}` (200)
2. Card hiển thị title + kind badge + `v{versionNo}` + `{updatedAt}` relative time
3. Saved-search replay: cùng expected behavior
4. Unit test `hybrid-to-search-hit.spec.ts` pass
5. MCP tool `search` output unchanged (existing tests pass)

## Deploy plan

1. Cook local — full commit trên `D:/Vietnt/Project/onemcp`
2. Push origin master onemcp repo
3. SSH `onemcp-vps` → `git reset --hard origin/master` → rebuild image backend + portal → `docker compose up -d`
4. Verify: search + saved-search click → 200
5. VPS `git status` clean

## Unresolved

- Có endpoint nào khác return `HybridSearchHit` HTTP không? (đã grep — chỉ 2 chỗ) — coi như đủ.
- Frontend `saved-searches.ts:53` typed `SearchHit[]` từ trước → tức đã là contract kỳ vọng; backend đơn giản đang không tuân thủ. Fix backend là đúng bản chất.
