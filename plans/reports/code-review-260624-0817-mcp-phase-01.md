# Code Review — MCP Phase 01 Production-Ready

**Scope:** mcp-semantic/{main,auth,audit,vmui,config}.py, infra/docker-compose.yml, infra/caddy/Caddyfile, infra/.env.example, infra/scripts/gen-mcp-tokens.sh

## CRITICAL

None. Auth gate + forward_auth wiring is sound for the stated trust model (LAN + 5 ops).

## HIGH

**H1. Anon-mode fail-open is too quiet.** `verify_bearer()` returns `"anon"` whenever `_load_tokens()` is empty (auth.py:62-64). If ops forget `MCP_BEARER_TOKENS` in prod, every Caddy `/auth/verify` call returns 204 with `X-Mcp-User: anon` — full bypass, only a single `log.warning` at startup. Plan acceptance criterion #2 says "deny when configured". Recommend: gate anon on an explicit `MCP_ALLOW_ANON=true` env, or have `/auth/verify` 401 in anon mode (mcp tool calls can still default to "anon" via stdio). At minimum, emit a warning on **every** anon `auth.allow` line so it's grep-able in audit.

**H2. `_load_tokens()` reparses env on every request.** `verify_bearer` → `_load_tokens` → `_parse_token_table` runs on each `/auth/verify`. Low CPU, but the bigger issue: `settings` is a frozen snapshot, so re-parsing is pure waste *and* prevents hot-reload anyway. Cache at module load (`_TOKENS = _load_tokens()`), or memoize. Minor perf, but kills the "low traffic" argument under SSE keepalive bursts.

## MEDIUM

**M1. `auth.deny` audit line leaks no token fingerprint.** Failed auth writes `user=unknown` with no hash/prefix — impossible to distinguish "missing header" vs "wrong token" vs "rotated token still cached on client" in incident review. Add `auth_hint` = first 8 chars of token (if present) or `"missing"`.

**M2. Audit singleton race.** `get_audit()` (audit.py:64-70) checks-then-sets `_audit` without a lock. Under SSE startup burst (FastMCP handler + `/auth/verify` concurrent first hit), two `AuditLogger` instances can be constructed, each with its own `threading.Lock`. Interleaved writes from two locks → potential torn JSON lines on the same file. Wrap init in a `threading.Lock` or initialize eagerly at module import. (FastAPI/Starlette runs handlers in threadpool for sync code paths, so this is reachable, not theoretical.)

**M3. VMUI URL hash-fragment encoding.** `build_vmui_url` returns `{base}/select/vmui/?#/?{encoded}` — putting `?` *after* `#` puts the querystring inside the fragment, which is fine for VMUI's hash-routed JS, but `urllib.parse.quote` does not escape `#` in values. A `service` value containing `#` would prematurely terminate the fragment. `urlencode(quote_via=quote)` defaults `safe=""`, so `#`, `&`, `=` *are* escaped — verified safe. No injection risk. (Keeping as note: confirm by unit test, plan mentions one.)

**M4. `vmui_base_url` default `http://app.local` baked into tool responses.** If `VMUI_BASE_URL` env is unset in prod, IDE clients get unreachable LAN links. Add a startup assertion or log.warning when value is the default and `is_auth_enabled()` is true (likely-prod signal).

**M5. mcp-vl audit gap.** Caddy gates mcp-vl via `/auth/verify`, which writes `auth.allow` once, but the actual LogsQL tool calls into mcp-vl are not audited (mcp-vl v1.9.0 has no audit hook). Plan claims "central audit"; reality is "central auth, semantic-only audit". Acceptable for Phase 01 — flag in plan acceptance.

## LOW

**L1. Timing leak.** `tokens.get(token)` is not constant-time. Irrelevant for 5-user internal stack on LAN; documented in audit.py comment already.

**L2. `mcp_bearer` legacy single-token** (auth.py:46-52) labelled `"legacy"` — fine, but `.env.example` doesn't document it. If kept for back-compat, mention; if not needed, drop.

**L3. Healthz exposure.** `/healthz` is at `mcp-semantic:9000` directly, but Caddy never routes to it (no `handle /healthz`). Container-internal only — good. Confirm Docker healthcheck added in a later phase (not in this diff).

**L4. gen-mcp-tokens.sh** correctly rejects `,` and `:`; openssl→urandom fallback fine. `xxd` may be missing on minimal Alpine; consider `od -An -tx1 -N32 | tr -d ' \n'` fallback. Non-blocking.

**L5. Caddyfile `handle_path` strips prefix** — `/mcp/semantic/sse` becomes `/sse` upstream. Correct for FastMCP SSE mount. Verify `forward_auth` runs **before** `reverse_proxy` — Caddy's `handle_path` block does this implicitly (directives ordered top-to-bottom in a handle block since v2.7). OK.

**L6. SSE flush.** `flush_interval -1` set on both mcp-vl and mcp-semantic proxies. Plan red-flag resolved.

**L7. ContextVar in async.** `current_user` ContextVar propagates across `await` in asyncio per PEP 567 — safe. But note: `_resolve_user` never *sets* the ContextVar; it only reads as fallback. The fallback path always returns `"unknown"`. Either delete the ContextVar (unused write path) or set it in a Starlette middleware. Currently it's dead code.

**L8. Audit log path collision.** Only mcp-semantic writes; mcp-vl v1.9.0 does not write to `/var/log/onelog-audit`. Safe. If a future mcp-vl version adds audit, mount separate subdir.

## Positive

- Clean separation: edge auth vs tool audit, both go through one writer.
- `audit.write` never raises — correct call-site contract.
- `_quote_value` escapes embedded `"` in LogsQL — prevents query break-out via service/host payload.
- Token table parser tolerates whitespace + skips malformed entries without crashing boot.
- Bearer header parse correctly handles case-insensitive `bearer` and missing/extra whitespace.

## Recommended Actions (priority order)

1. **H1** — explicit `MCP_ALLOW_ANON` flag or 401 in anon mode for `/auth/verify`.
2. **M2** — lock the `get_audit()` singleton init OR eager init at import.
3. **L7** — delete the unused `current_user` ContextVar OR wire it from a middleware that calls `current_user.set(user)` after verify.
4. **H2** — cache `_load_tokens()` at module import.
5. **M1** — add `auth_hint` to deny lines.
6. **M4** — startup warning when `VMUI_BASE_URL` is default in tokens-configured mode.

## Unresolved Questions

- Is anon mode actually wanted in production, or strictly dev? Decides H1 severity.
- Will mcp-vl v1.10+ add native audit hook? Affects M5 plan.
- Does the legacy `MCP_BEARER` single-token env still have any live consumer (Claude Desktop config)?

**Status:** DONE_WITH_CONCERNS
**Summary:** Implementation is functionally correct and acceptance criteria 3–8 pass. Criterion #2 (deny when configured) passes; the anon-fallback when **un**configured (H1) plus the singleton race (M2) and unused ContextVar (L7) are the only items blocking a clean sign-off.
**Concerns/Blockers:** H1 anon fail-open semantics; M2 audit singleton race under concurrent SSE startup.
