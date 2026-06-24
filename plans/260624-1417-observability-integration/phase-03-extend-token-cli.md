# Phase 03 — Extend `gen-mcp-tokens.sh` CLI

## Context
- Plan: [plan.md](plan.md)
- Independent: có thể chạy song song Phase 01/02, hoặc skip nếu ops thấy 5 token quý/lần đủ rồi
- Base: `infra/scripts/gen-mcp-tokens.sh` (hoặc `rotate-mcp-tokens.sh`) đã tạo trong Phase 01 mcp-only-rollout

## Overview
- Priority: P2 (bonus)
- Status: pending
- Effort: ~0.5 ngày-người
- Mục tiêu: extend CLI hỗ trợ subcommand `add | list | revoke` để ops thêm/xóa user MCP không phải tay edit `.env`.

## Key insights
- Hiện tại flow: edit `.env` → restart compose. Manual, dễ typo token.
- 5 ops × ~1 token/quý = low frequency → bash script đủ, KHÔNG cần admin UI (YAGNI)
- Audit JSON append cho mọi op để compliance

## Architecture
```
gen-mcp-tokens.sh {add|list|revoke|--help} <user>
   │
   ├─► parse .env MCP_BEARER_TOKENS
   ├─► mutate (add/remove entry)
   ├─► write back .env atomically (tmp + mv)
   ├─► docker compose restart mcp-semantic
   └─► append /var/log/onelog-audit/token-cli.log JSON
```

## Related files

**Modify:**
- `infra/scripts/gen-mcp-tokens.sh` — thêm subcommand dispatch

**Create:**
- `infra/scripts/tests/test-gen-mcp-tokens.sh` — bash test cases (use `bats` hoặc plain `set -e`)

## Implementation steps

### Step 1 — Refactor entrypoint (0.1d)
1. Top of script: dispatch theo `$1` ∈ {add, list, revoke, --help, -h}
2. Default behavior (no arg) → print help (KHÔNG gen toàn bộ token như cũ, tránh tai nạn)
3. Validate `.env` path: `INFRA_ENV=${INFRA_ENV:-infra/.env}`, exit nếu không tồn tại

### Step 2 — Subcommand `add <user>` (0.15d)
1. Validate `<user>` regex `^[a-z][a-z0-9_]{1,30}$`
2. Check user đã exist trong `MCP_BEARER_TOKENS` → exit 1 nếu có
3. Gen token: `printf 'sk-mcp-%s' "$(openssl rand -hex 24)"`
4. Append entry `user:sk-mcp-xxx` vào `MCP_BEARER_TOKENS` env line atomically (sed + tmp file)
5. `docker compose restart mcp-semantic`
6. Audit log entry `{ts, op:add, user, actor:$USER}` (không log token raw)
7. Print token ra stdout (1 lần, ops copy ngay)

### Step 3 — Subcommand `list` (0.1d)
1. Parse `MCP_BEARER_TOKENS` thành cặp user:token
2. Print table: `user | masked_token` (mask = `sk-mcp-XXXX...XXXX` first4 + last4)
3. Không cần restart, không audit (read-only)

### Step 4 — Subcommand `revoke <user>` (0.1d)
1. Validate user exist
2. Remove entry khỏi `MCP_BEARER_TOKENS`
3. Atomic write `.env`
4. `docker compose restart mcp-semantic`
5. Audit log `{ts, op:revoke, user, actor:$USER}`

### Step 5 — Help + tests (0.05d)
1. `--help / -h`: print usage block
```
Usage: gen-mcp-tokens.sh <command> [args]
Commands:
  add <user>      Generate token cho user mới, append .env, restart mcp-semantic
  list            List user + masked token
  revoke <user>   Xóa user khỏi .env, restart mcp-semantic
  --help          Show this help
```
2. `tests/test-gen-mcp-tokens.sh`:
   - Setup tmp `.env` với 2 user mẫu
   - add new user → assert .env contain, audit log line ++
   - add duplicate user → exit code 1
   - list → assert mask format
   - revoke existing → assert .env không còn
   - revoke non-exist → exit code 1
   - Mock `docker compose restart` (override PATH với fake `docker` script)

## Todo
- [ ] Refactor dispatch + help
- [ ] Implement `add`
- [ ] Implement `list`
- [ ] Implement `revoke`
- [ ] Audit log writer (shared function)
- [ ] Tests pass local
- [ ] Update `docs/observability-integration.md` reference (hoặc `docs/runbook-mcp.md` nếu có)

## Success criteria
- `add alice` → token gen, `.env` updated, mcp-semantic restart, alice auth được MCP ngay
- `list` → mask format đúng, không leak full token
- `revoke alice` → alice mất quyền MCP sau restart
- Audit log có entry cho mỗi add/revoke
- All test cases pass

## Risks
- Race nếu 2 ops chạy script đồng thời → mitigate bằng `flock infra/.env.lock`
- Restart mcp-semantic làm gián đoạn user khác đang dùng MCP (≤5s downtime) → acceptable cho 5 ops nội bộ
- Audit log permission: chỉ user trong group `onelog-ops` write được

## Security
- Token raw chỉ print stdout 1 lần khi `add`, không log file
- Audit log chứa user + actor + ts, KHÔNG token
- `.env` permission `chmod 600`, owner ops group
- Validate user regex tránh shell injection

## Unresolved questions
- Có cần backup `.env` trước khi mutate (vd `.env.bak.<ts>`)? Mặc định YES để rollback dễ.
- Audit log path conflict với MCP audit (`/var/log/onelog-audit/mcp-*.log`)? Đề xuất file riêng `token-cli.log`.
- Có nên thêm `rotate <user>` (revoke+add atomic) không, hay user gọi 2 lệnh đủ? KISS: skip, ops gọi 2 lệnh.
