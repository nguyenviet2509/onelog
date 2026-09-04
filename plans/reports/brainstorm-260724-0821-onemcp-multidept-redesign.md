# OneMCP multi-dept redesign — brainstorm summary

- **Date:** 2026-07-24
- **Scope:** OneMCP v1 → v1.5 để mở rộng cho Ops/Support (bên cạnh phòng kỹ thuật), UI polish, data model nhẹ, không over-engineer
- **Approach chốt:** B (MCP-first, thin polish)
- **Auth chốt:** giữ trust header + thêm API key per-user (OIDC hoãn)
- **Target teams đợt này:** Ops / Vận hành + Support (dev vẫn dùng qua OpenWebUI/Claude)

---

## 1. Problem statement

OneMCP v1 stable, bridge OneLog→KB đã live (commit bd5495a), nhưng:
- Portal sơ sài: flat list, không dashboard, không diff, không bulk, không stats
- Search chỉ FTS+fuzzy → risk miss cao cho non-tech query (đã flag 40%)
- Data model artifact type cứng, thiên kỹ thuật (kb/report/postmortem/runbook) — Ops/Support cần SOP, FAQ khách hàng, script xử lý ticket
- Single-dept assumption trong UI (schema có departmentId, portal không dùng)
- Auth trust-header + bot user duy nhất trong bridge → mất per-user attribution
- Non-tech không có onboarding, không biết bắt đầu từ đâu

**Mục tiêu:** Ops/Support tự submit KB (SOP xử lý ticket, FAQ khách, playbook) và tìm được nhanh; dev vẫn dùng qua MCP như cũ; không phải xây lại portal.

---

## 2. Design — 5 khối thay đổi

### 2.1 Data model (backend, migration nhẹ)

**Thêm bảng `spaces`:**
```
spaces (
  id bigserial PK,
  slug varchar(64) unique,
  name varchar(120),
  description text,
  department_id bigint FK,
  icon varchar(32),            -- emoji hoặc icon key
  visibility enum(dept, cross_dept),
  created_at, updated_at
)
```
- Mỗi dept có 1+ space (VD Ops: `ops-runbook`, `ops-oncall`, `support-faq`)
- Space là đơn vị filter chính trong search + UI selector
- Migration: tạo space mặc định per dept, backfill artifact.space_id từ artifact.department_id

**Sửa `artifacts`:**
- Thêm `space_id` FK (not null sau backfill)
- Đổi `type` từ enum thành `template_key varchar(64)` — trỏ tới `templates` table
- Thêm `visibility enum(space, dept, cross_dept)` — default `space`
- Thêm `view_count int default 0`, `last_viewed_at`

**Thêm bảng `templates` (registry động):**
```
templates (
  key varchar(64) PK,           -- 'sop', 'faq', 'runbook', 'kb', ...
  label varchar(120),
  description text,
  schema jsonb,                 -- {required: [...], optional: [...], field_labels: {...}}
  ui_hints jsonb,               -- {icon, color, order}
  department_scope varchar[],   -- null = all depts, else whitelist
  active bool default true
)
```
- Bỏ template-registry.ts hardcode
- Admin thêm template qua CLI/portal → không cần deploy
- Templates cho đợt này: giữ 5 cũ + thêm `sop`, `faq`, `ticket_playbook`, `announcement`

**Thêm bảng `api_keys`:**
```
api_keys (
  id bigserial PK,
  user_id bigint FK,
  key_hash varchar(128),         -- bcrypt hoặc sha256 pepper
  key_prefix varchar(12),        -- hiển thị trong UI (VD "omk_a1b2...")
  label varchar(80),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked bool default false,
  created_at
)
```
- User gen key từ portal `/profile/api-keys`
- Auth middleware: nếu header `X-Onemcp-Key: omk_...` thì lookup + rate limit theo key
- Trust header vẫn giữ song song cho tool-to-tool + backward-compat

**Bật pgvector:**
```
embeddings (
  artifact_version_id bigint PK FK,
  vector vector(1024),           -- bge-m3 dim
  model varchar(32),             -- 'bge-m3-v1'
  created_at
)
```
- Job async: mỗi artifact publish → enqueue embed → gọi embedding service (self-host hoặc gemini)
- Hybrid search: BM25 (FTS hiện tại) + cosine (pgvector) → RRF (reciprocal rank fusion) merge

### 2.2 Search overhaul

- **Semantic hybrid**: FTS + vector, RRF k=60, filter theo space/dept/tag/template_key trước rồi rank
- **API `/api/search`** thêm params: `space_id`, `template_key`, `tags[]`, `mode=hybrid|fts|semantic`
- **Snippet highlight**: giữ FTS ts_headline cho FTS hit, generate riêng cho vector-only hit (window quanh chunk match)
- **Saved queries**: table `saved_searches(user_id, query, filters_json, name)` — user pin query hay dùng
- **MCP tool `search`**: thêm optional `space` param + `mode` — client cũ vẫn work vì optional

### 2.3 Portal UI polish (Next.js)

**Không rebuild — extend những trang có sẵn.**

Trang mới / update:
- **`/` Home** → Dashboard:
  - Widget: recent activity (my dept), my drafts, pending review count (nếu maintainer), top viewed 7d, top tags
  - CTA: "Submit new" dropdown theo template
- **Sidebar space switcher**: dropdown header (không tree) — chọn space → filter mọi trang
- **`/artifacts`** → thêm filter panel (space, template, tag, author, status, date range), bulk action bar (multi-select → approve / archive / export CSV)
- **`/artifacts/{id}`**:
  - Tab: View | Edit | History | Attachments
  - History tab: side-by-side diff giữa versions (dùng `react-diff-viewer-continued`)
  - View: view_count + last_viewed hiển thị
  - Nút "Copy MCP link" (deep link cho Claude/OpenWebUI)
- **`/artifacts/new`**:
  - Template picker card grid (icon + description từ templates table)
  - Rich markdown editor (TipTap markdown mode hoặc `@uiw/react-md-editor` — nhẹ, không WYSIWYG phức tạp)
  - Live preview split view
- **`/search`**:
  - Filter panel bên trái
  - Toggle mode (hybrid default, có thể switch sang FTS-only để debug)
  - Snippet highlight, badge template + space + tags
  - "Save this search" button
- **`/profile/api-keys`** (mới):
  - List key (label, prefix, last_used, expires), create/revoke button
  - Show full key duy nhất 1 lần khi tạo, cảnh báo copy ngay
- **`/spaces`** (admin):
  - CRUD space, gán department, icon
- **`/onboarding`** (mới):
  - Static page mỗi dept: "How to use OneMCP for [Ops/Support]" — copy được template, ví dụ 3 KB mẫu, link tới OpenWebUI dept bot

**Component library:** dùng shadcn/ui (nếu chưa có) để rút ngắn dev time — không tự build design system.

### 2.4 Bridge OneLog→KB (per-user attribution)

Current: 1 bot `openwebui-bot` submit tất cả.

Update:
- OpenWebUI Action `onemcp-submit-kb.py` đọc `__user__.email` từ context
- Map email → OneMCP user (auto-provision nếu chưa có, role=contributor)
- Submit với header `X-Onemcp-User: <derived-username>` thay vì bot
- Bot user vẫn giữ cho tool-call tự động không có user context (VD alertmanager webhook)

**Lợi:** attribution thật, review team biết ai submit, per-user rate limit.

### 2.5 Onboarding cho Ops/Support (non-tech tooling)

Không phải code — nhưng critical cho adoption:
- Tạo **OpenWebUI workspace "Ops Helper"** với system prompt + tools scoped `space=ops-*`, `space=support-*`
- Tạo **3 SOP mẫu** trong space `support-faq`: xử lý ticket P1, escalation matrix, giao tiếp khách hàng
- Video demo 5 phút: "Cách 1 support paste transcript → submit KB → search lần sau"
- Slack/email announce: link portal, link OpenWebUI, contact maintainer

---

## 3. Non-goals đợt này (tránh scope creep)

- ❌ Comments / reactions / threads
- ❌ Nested tree / parent-child artifact
- ❌ WYSIWYG editor phức tạp (Notion-style block)
- ❌ Per-artifact permission fine-grained (dùng visibility enum đơn giản)
- ❌ Chat AI trong portal (dùng OpenWebUI có sẵn)
- ❌ OIDC / SSO (hoãn)
- ❌ Real-time collaboration
- ❌ Mobile app riêng (portal responsive là đủ)

---

## 4. Implementation phases (đề xuất)

**Phase 1 — Data model + auth (1 tuần):**
- Migration: spaces, templates table, api_keys, embeddings, artifact.space_id + template_key + visibility
- Backfill: default space per dept, template_key = old type
- API key middleware + rotate endpoint
- Bridge update: per-user attribution

**Phase 2 — Search hybrid (1 tuần):**
- Embedding worker (BullMQ queue `embed-artifact`)
- Embedding client (bge-m3 self-host hoặc gemini API)
- Search service: hybrid + RRF + filter API extend
- MCP `search` tool schema update

**Phase 3 — Portal polish (2 tuần):**
- Dashboard home
- Space switcher + filter panel + bulk actions
- Rich editor + template picker + preview
- Version diff view
- API keys page
- Saved searches

**Phase 4 — Ops onboarding (0.5 tuần):**
- Templates SOP/FAQ/ticket_playbook seed
- OpenWebUI Ops workspace setup
- 3 SOP mẫu
- Onboarding page + docs

**Total:** ~4.5 tuần dev + 0.5 tuần buffer/QA = **5 tuần**.

---

## 5. Risks & mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Embedding service latency / cost | Bridge submit chậm | Embed async job, không block submit; fallback FTS nếu vector unavailable |
| bge-m3 self-host memory hog | VPS overload | Dùng gemini embedding API trước (rẻ, không host); benchmark rồi mới self-host |
| Template migration bug | Artifact mất type | Migration reversible, keep old enum column 1 release, dual-read |
| API key leak | Unauthorized access | Prefix + last_used tracking, revoke UI, per-key rate limit, expire default 90d |
| Ops team không adopt | Feature waste | Onboarding page + demo video + Slack push; measure submit rate/dept sau 4 tuần |
| Portal polish scope creep | Delay ship | Non-goals list ở §3 là hard boundary, review PR chống add feature ngoài scope |
| pgvector index size trên VPS | Disk pressure | ivfflat index thay hnsw đợt đầu, monitor size, escalate hnsw sau |

---

## 6. Success metrics (4 tuần post-ship)

- ≥ 3 Ops user submit ≥ 1 KB mỗi user
- ≥ 20 KB Ops/Support published (không tính tech)
- Search hit rate (click ≥1 result) ≥ 60% (baseline chưa đo)
- ≥ 5 saved searches active
- Bridge attribution 100% per-user (không còn bot fallback ngoài alertmanager)
- API key adoption: ≥ 10 keys active
- 0 rollback / hotfix migration

---

## 7. Open questions / dependencies

1. Embedding provider: gemini API vs self-host bge-m3 — quyết tuần đầu Phase 2, cần benchmark cost + latency
2. VPS resource: pgvector + embedding worker có ăn thêm RAM/CPU không — cần đo current headroom
3. shadcn/ui portal hiện tại đã dùng chưa? Nếu chưa, có OK migrate không (dev cost ~2-3 ngày extra)
4. Ops team lead ai — cần identify để chốt template SOP/FAQ trước Phase 4
5. OpenWebUI workspace multi-scope: OpenWebUI có support workspace-level tool filter không, hay phải fork Function code — cần verify tuần đầu
6. Backfill artifact type → template_key: có artifact nào type null/legacy không — check DB trước migration

---

## 8. Next steps

1. User review + approve design này
2. Nếu approve → chạy `/ck:plan` tạo plan chi tiết `plans/260724-XXXX-onemcp-multidept-v1.5/` với 4 phases + phase files
3. Resolve open question #1-6 trong research phase của plan
