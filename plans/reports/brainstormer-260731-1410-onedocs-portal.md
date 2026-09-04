# OneDocs Portal — Brainstorm Summary

**Date:** 2026-07-31 14:10 · **Owner:** chuongdt@inet.vn · **Status:** design approved, ready for `/ck:plan`

## Problem statement

Phòng KT hiện có 2 dự án chính (OneLog, OneMCP) với ~35 MD docs rải rác trong `docs/` mỗi repo + mockups HTML. Cần:
- 1 portal docs thống nhất, sidebar rõ ràng, phân biệt project, scale được project mới
- Bao phủ: features, infra, sơ đồ, workflow (bao gồm cross-project)
- Light/dark mode, deploy VPS với domain custom (cấp sau)
- **MCP-driven contribution**: member push docs từ Claude Desktop → validate format → publish → auto-deploy
- Skill + rules đảm bảo LLM soạn docs đúng format, không phá UI/cấu trúc

## Evaluated approaches

### Stack SSG
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Docusaurus 3** | Multi-instance docs plugin, MDX, Mermaid, search local, dark mode built-in, ecosystem lớn | React overhead, build 30-60s | ✅ Chosen |
| VitePress | Nhẹ, nhanh, Vue | Multi-project pattern kém linh hoạt hơn | ❌ |
| Nextra | Đẹp | Multi-project cần config tay nhiều | ❌ |
| Custom HTML | Full control | Reinvent wheel | ❌ |

### Content strategy
✅ **Hybrid** — bootstrap import toàn bộ MD hiện có vào `content/<project>/legacy/`, viết mới landing + architecture overview. Curate dần sang `guides/`, `ops/` sau launch.

### Contribution flow
✅ **Direct commit + auto-deploy** — MCP tool `docs.publish` validate → commit main → post-receive hook rebuild+rsync. Trust-based cho team nhỏ, bù bằng audit log + Telegram notify.

### MCP host
✅ **Trong OneMCP stack**, expose streamable HTTP `/mcp/onedocs/mcp`, auth API key per-member.

### Deploy
✅ **onelog-vps + Caddy** static, ENV var `DOCS_DOMAIN` inject sau, basicauth private.

## Final architecture

```
Member Claude Desktop
    ↓ MCP streamable HTTP + API key
mcp-onedocs (FastMCP, OneMCP stack VPS)
    ↓ git ops (file lock, validate, commit)
onedocs repo (GitHub private canonical + VPS bare mirror)
    ↓ post-receive hook
Build container (node:20 + docusaurus build)
    ↓ rsync
/opt/onelog/docs-site/ ← Caddy serve docs.<DOMAIN> (basicauth)
    ↓ Telegram bot
Notify lead mỗi publish
```

### Repo layout (D:/Vietnt/Project/onedocs/, junctioned to onelog/onedocs)

```
docusaurus.config.ts        # multi-instance docs plugin
sidebars.ts                 # auto-gen từ folder + frontmatter position
content/
  onelog/{index,architecture,changelog}.mdx + guides/ ops/ legacy/
  onemcp/{...}
  _shared/                  # protected, chỉ lead sửa
    infra-overview.mdx      # sơ đồ toàn phòng KT
    glossary.mdx
    contributing.mdx
    onboarding.mdx
src/
  components/RelatedProject.tsx    # cross-project badge
  css/custom.css                   # 1 theme, light/dark toggle
schemas/
  frontmatter.schema.json          # dùng chung MCP + pre-commit
  contributing-rules.md
scripts/
  validate.mjs                     # schema + MDX + link + Mermaid check
  bootstrap-import.mjs             # migration legacy docs
  build-and-deploy.sh
.markdownlint.jsonc
```

### MCP tools (mcp-onedocs, FastMCP Python)

| Tool | Purpose |
|---|---|
| `docs.projects()` | List project + category tree |
| `docs.schema(project?)` | Trả frontmatter schema + rules current |
| `docs.list(project?)` | List trang + frontmatter |
| `docs.get(project, path)` | Đọc raw MD |
| `docs.preview(project, path, content)` | Render HTML preview |
| `docs.publish(project, path, content, message)` | Validate → commit → push → rebuild |
| `docs.related(project, path)` | Suggest cross-project link (v2 sau khi có embedding) |

### Validation gates (`docs.publish`)

1. Frontmatter JSON Schema (required: `title`, `project`, `category`, `updated`)
2. Path whitelist `content/<project>/<category>/*`, kebab-case filename
3. markdownlint-cli2
4. MDX component whitelist: `RelatedProject`, `Mermaid`, `Tabs`, `Admonition` — chặn raw `<style>`, `<script>`, inline CSS
5. Không cho edit `_shared/` qua MCP
6. Mermaid parse thử
7. Internal link exists

### Contribution rules (3-layer enforcement)

1. **MCP schema tool** — LLM đọc schema trước khi soạn
2. **`push-onedocs` skill** — flow chuẩn, template embedded, style guide
3. **Server validation** — reject → LLM đọc error → retry

## Scope v1 (all approved)

| # | Item | Notes |
|---|---|---|
| 1 | Docusaurus 3 site + light/dark toggle + search local | flexsearch/lunr, no Algolia |
| 2 | Content structure: onelog, onemcp, _shared | scaleable pattern |
| 3 | Migration script bootstrap import MD cũ vào `legacy/` | không block launch |
| 4 | `RelatedProject` MDX component | cross-project badge |
| 5 | mcp-onedocs FastMCP server trong OneMCP stack | 7 tools |
| 6 | 3-layer validation (schema/skill/server) | fail-fast |
| 7 | `push-onedocs` skill + `.claude/rules` cho member | onboarding-friendly |
| 8 | API key CLI bootstrap trên VPS | manual issue by lead |
| 9 | Direct commit → post-receive rebuild → rsync Caddy | ~1-2 phút TTL |
| 10 | Basicauth Caddy, ENV `DOCS_DOMAIN` placeholder | fill sau |
| 11 | Audit log `.onedocs/audit.jsonl` + rate limit 20/hour/key | anti-abuse |
| 12 | Preview-only cho member (docs.preview), no local clone required | zero setup |
| 13 | GitHub private canonical + VPS bare mirror + backup pattern | reuse `deployment-backup-offsite.md` |
| 14 | Telegram bot notify mỗi publish (token cấp sau) | audit visibility |
| 15 | Testing: unit validator + integration MCP + full flow + CI validate/build | GitHub Actions on push |
| 16 | Onboarding page `_shared/onboarding.mdx` | xin key → config → skill → test publish |

## Deferred to v2

- `docs.rollback` MCP tool
- AI-suggest related via qdrant embedding
- CODEOWNERS auto-approval warn
- Preview branch URL cho draft
- VS Code extension
- Portal UI cho API key issue
- Versioning + i18n
- CI auto-deploy on push (hiện dùng post-receive hook đủ)

## Implementation considerations & risks

| Risk | Mitigation |
|---|---|
| Concurrent publish race | File lock trong MCP, timeout 30s |
| LLM hallucinate frontmatter | Schema validate hard-fail, không nới lỏng |
| MCP endpoint public bị abuse | API key + rate limit + IP allowlist optional |
| Build container fail | Post-receive rollback commit trước + Telegram alert |
| Symlink MD cross-drive không work Windows | Dùng copy script `bootstrap-import.mjs` thay symlink |
| Trust-based direct commit sai | Audit log + Telegram notify → lead phát hiện nhanh, dùng `git revert` |
| Member không biết viết đúng format | 3-layer: schema tool → skill embedded rules → server reject cụ thể |

## Success metrics

- Member publish trang đầu tiên < 15 phút từ lúc nhận API key
- 100% publish pass validation (retry rate < 20%)
- Build+deploy TTL ≤ 2 phút từ `docs.publish` → live
- 0 UI break commit trong 30 ngày đầu
- Docs coverage: mọi service OneLog/OneMCP có ít nhất `index` + `architecture` + `ops` trang
- Search hit rate > 80% (log query rỗng để đánh giá)

## Dependencies

- OneMCP stack đã chạy trên VPS (đã có)
- FastMCP 3.x (đã dùng trong onemcp/mcp-vl)
- Node 20 build environment (thêm image vào docker-compose)
- Domain (cấp sau) → fill `DOCS_DOMAIN` env
- Telegram bot token (cấp sau) → fill `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
- GitHub repo `onedocs` (đã tạo, đã junction từ OneLog)

## Next steps

1. Trigger `/ck:plan` với context report này để phân phase implementation
2. Phase gợi ý (planner sẽ finalize):
   - P1: Docusaurus scaffolding + theme + sidebar structure + migration script
   - P2: Cross-project component + `_shared` pages + rules doc
   - P3: mcp-onedocs FastMCP server + validation + audit log + rate limit
   - P4: `push-onedocs` skill + `.claude/rules` doc + onboarding page
   - P5: Deploy pipeline (post-receive hook + build container + rsync + Caddy) + Telegram notify
   - P6: Testing + CI + go-live checklist

## Unresolved questions

- Domain cuối cùng (anh cấp sau) → giữ `DOCS_DOMAIN` env
- Telegram bot token + chat ID (anh cấp sau) → giữ env placeholder
- Member list ban đầu (ai nhận API key first batch)?
- Có cần IP allowlist cho MCP endpoint không, hay API key + rate limit là đủ?
- `_shared/` protected — cơ chế enforce ở tầng nào (MCP hard-block vs codeowner)? Hiện đề xuất MCP hard-block.
