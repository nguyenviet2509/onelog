# Prod-readiness cleanup + LogServer rotation A+E shipped

**Date:** 2026-07-10
**Plans:** none (Wave 1 direct fixes) + [260710-1432-logserver-rotation-a-plus-e](../../plans/260710-1432-logserver-rotation-a-plus-e/)
**Commits:** `090def0` (Wave 1) · `1d51a53` (feat rotation) · `8eb3c78` (plan artifacts)
**Status:** ✅ Repo work done, pushed master. ⏸️ Phase 01 (host daemon.json) chờ SSH ops.

## What landed

### Wave 1 — prod-readiness cleanup (audit-driven, no plan)
- **Top-level `README.md`** — clone repo giờ có entry point.
- **Docker image tag pinning** — 4 `:latest` → env vars `VL_IMAGE_TAG`/`QDRANT_IMAGE_TAG`/`VMALERT_IMAGE_TAG`/`ALERTMANAGER_IMAGE_TAG` (default `latest`, prod override qua `.env`).
- **Agent Dockerfile HEALTHCHECK** — curl `/health` endpoint có sẵn.
- **Agent mock timestamp** — cứng `2026-06-23T04:00:00Z` → `datetime.now(UTC)` động.
- **Indexer fail-fast** — `OPENAI_API_KEY` bắt buộc khi `EMBED_MOCK=false` (Pydantic model_validator). Chống silent switch sang mock vectors trong prod = poisoned Qdrant.
- **Web `package.json` engines** — Node >=18.17 (Next.js 14 requirement).

### Plan 260710-1432 — Docker log rotate + disk alerts
- Phase 02 shipped in repo:
  - Vector exec probe `probe-logserver-disk.sh` (data disk) — narrow bind `/opt/ragstack/data:/host/data:ro,rslave`.
  - Host cron probe `probe-host-disk-root.sh` (`/`) — curl JSON direct vào VL `/insert/jsonline`.
  - vmalert group `disk-alerts` với 5 rules (2-tier warning@75/critical@88 × 2 mounts + DiskProbeStale).
- Phase 03 shipped: mockup `#ls-rotation` section (4 card) + deployment-guide verify block.
- Phase 01 (host): daemon.json checklist paste-ready cho ops SSH.

## Inflection points

1. **Audit revealed web/ decommissioned, không phải blocker prod.** 4 "auth stub blocker" web bị flag ban đầu → thực tế `web/` đã commented out trong compose từ 2026-06-24 (branch `legacy-web` kept for resurrect). Chỉ agent stub cần deal — mà là architectural (OIDC), không dev-artifact.

2. **VL compression thực sự thay đổi capacity math.** User hỏi rotation cho 100-500 clients. Bảng scale mới: 1000 clients @ 30d = 240 GB stored. 905 GB thừa sức. **VL không phải nguồn rủi ro** — Docker log unbounded trên `/` (98 GB) mới là time bomb. Refocus fix set từ 5 items (A-E) xuống 2 (A + E).

3. **Red-team surface 5 Critical bug trong plan v1**:
   - **Bind mount propagation**: `/:/host/rootfs:ro` KHÔNG thấy `/opt/ragstack/data` submount nếu thiếu `rslave`. Probe report sai partition — silent monitoring failure.
   - **Security compound risk**: `/host/rootfs` + existing `docker.sock` = full host takeover primitive. Vector RCE → dump `.env` → spawn privileged container.
   - **LogsQL syntax broken 3 layer**: thiếu `_time:15m` filter (commit d55a6d6 chứng minh cần), `last()` unverified (precedent chỉ dùng `max()`), `filter value:>75` word syntax vs `value > 75` math syntax.
   - **Sink name `vl_monitor` không tồn tại** — tên tự bịa; actual là `victorialogs` sink.
   - **Systemd cascade**: `ragstack.service` có `Requires=docker.service` → restart docker cascade stop ragstack race với step recreate.

   Bài học: plan v1 vô tình copy giả định — verify bằng cách đọc CODE THẬT là bước red-team quan trọng nhất.

4. **Redesign: 2 probe topology thay 1**. Sau red-team, chuyển từ 1 Vector probe (bind rootfs) → **narrow bind data disk** + **host cron probe root**. Cost +5 phút setup, benefit: eliminate takeover primitive + independent failure mode (nếu Vector chết, host cron vẫn báo `/`).

5. **Anti-injection layer**: red-team #12 phát hiện attacker container có thể log `{service:"logserver-disk-monitor",used_pct:0}` để suppress alert. Fix: Vector remap **hard-set** `source_stream:"vector-exec-probe"` (overwrite mọi upstream forge attempt) + LogsQL rule filter cả 2 tag. Attacker phải kiểm soát Vector transform mới bypass được.

6. **Force-test rewrite**: plan v1 recommend `dd fill 200GB` — red-team pointed out cùng volume với VL live data → chính plan có thể trigger scenario nó bảo vệ. Chuyển primary → "lower threshold tạm" (không đụng disk).

## Verified & unresolved

✅ YAML/JSON/HTML/shell syntax pass local.
✅ 2 commit + push master done.
✅ Plan doc + brainstorm report committed cùng.
⏸️ **Phase 01 (host daemon.json)** — chờ SSH ops chạy checklist. Sequence: `stop ragstack → dockerd --validate → restart docker → auto-rollback nếu fail → start ragstack → up -d --force-recreate full profile`.
⏸️ **Phase 02 apply trên host** — cần `git pull` + `docker compose up -d --force-recreate vector` + `restart vmalert` + cài host cron.
⏸️ **Force test alert** — lower threshold trick → wait 20m → verify Telegram Issue topic.
❌ Runtime verify chưa được (Windows dev env, no docker).

## Lessons for next cook

- **Verify sink names, LogsQL functions, systemd deps từ file thật** trong bước codebase analysis. Đừng invent hoặc copy pattern chung chung. Red-team's assumption-destroyer lens = "cite BOTH claim AND actual code" là cực kỳ effective.
- **Compound security risks**: bind mount đơn lẻ có vẻ safe → combined với docker.sock existing = takeover primitive. Luôn check cross-mount attack surface trong Vector-like service.
- **Test procedures phải KHÔNG tạo scenario chúng bảo vệ**. `dd fill` để test disk alert = chính nó có thể fill disk. Prefer "lower threshold" hoặc mocked source.
- **VL ZSTD compression math**: 10-40× thực tế shift capacity planning conversations. 500 GB raw → 15-30 GB stored @ 7d. Chưa cần scale disk cho scope 100 clients.
- **Docker log rotate host-level > per-service**: 1 file `/etc/docker/daemon.json` cover 14 container thay vì 14 compose block. Per-service override vẫn work cho case cần custom (litellm giữ max-file:5).

## Next steps

1. Ops SSH → phase 01 checklist (daemon.json + systemd sequence).
2. Ops `git pull` + phase 02 apply commands + host cron install.
3. Force test alert (lower threshold trick, không dd).
4. 24h monitor baseline → mark plan `completed`.
5. Track defer triggers B (NATS max_bytes @ 5M msgs) / C (VL retention @ 80%) / D (backup @ 300 GB).
