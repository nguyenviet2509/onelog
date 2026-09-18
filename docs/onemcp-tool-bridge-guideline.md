# OneMCP Tool Bridge — Guideline

Adding a new tool bridge exposes an external HTTP endpoint as an MCP tool callable by LLMs via Claude Desktop. This doc sets the bar for when to add, how to design, and what to check before enabling.

---

## Live discovery (Option D — recommended workflow)

Register bridge once with discovery endpoint → dev osh_admin maintains tools list autonomously. Recommended for actively developed backends.

### Setup (Admin OneMCP, one-time)

1. Admin UI → `https://oneconnector.000nethost.com/admin/tool-bridges` → Upstreams tab
2. Create new upstream: `Name: osh_admin`, `Base URL: https://osh-admin.domain` (or dev mock)
3. **NEW**: Set optional field `Discovery URL: https://osh-admin.domain/tools/list` (or endpoint path per upstream)
4. Paste bearer token (same as tool calls)
5. Save → OneMCP caches endpoint for 60s, refreshes on every tools/list call

### Iterate freely (Dev osh_admin)

1. Add/modify endpoint in osh_admin code
2. Update `/tools/list` endpoint to include new tool in response (or build dynamically from router registry)
3. Deploy osh_admin
4. Within ≤60s: bridge visible in Claude Desktop tools/list
5. Or: Admin clicks "Refresh cache" in OneMCP portal for immediate effect
6. LLM calls tool → OneMCP dispatches same as manual bridge

**No handoff friction**: dev controls tool list entirely. OneMCP just proxies.

### When to use manual bridges (legacy)

Use manual bridge registration when:
- Endpoint is **external SaaS** (no discovery capability)
- osh_admin is **old version** or **doesn't support** `/tools/list` endpoint
- Admin needs **full control** over description/param_schema independently (rare — most apps own their own docs)
- Endpoint changes infrequently and sync burden is acceptable

**Trade-off**: manual = zero autonomy for dev, admin OneMCP controls tool lifecycle entirely.

**Reference**: Full discovery spec and troubleshooting at `[onemcp-bridge-discovery-spec.md](./onemcp-bridge-discovery-spec.md)`.

---

## When to add a tool

All must be true before registering a bridge:

- [ ] The operation has a **clear, atomic intent** — one tool does one thing (not "execute command on system X")
- [ ] The upstream HTTP endpoint is **stable** — URL, method, and response schema won't change without notice
- [ ] **param_schema is finalized** with the upstream team — changing schema after enable breaks existing prompts
- [ ] A **permission name** is agreed (`<app_slug>:tool.<snake_case>`) and the upstream app owns the check
- [ ] The bearer token is **provisioned** and stored securely (not hardcoded in compose, not in chat)
- [ ] The tool has been **dry-run tested** via Admin UI test-call before enabling for users
- [ ] **Security checklist** (below) is completed

Do NOT add if:
- The operation is destructive and irreversible without a confirmation step designed into the prompt
- The upstream endpoint has no auth (or auth is planned "later")
- The param_schema is "we'll figure it out" — lock it first

---

## Tool description template

Format: **Verb + object + context + when to use**

```
Creates a WAF block rule for a domain/IP pair on the osh_admin firewall.
Use when the user wants to block a specific IP or CIDR from accessing a domain.
Requires: domain (FQDN), ip (IPv4/CIDR). Optional: rules array (default: ["block"]).
```

**Good examples**:

| Description | Why good |
|---|---|
| "Creates a WAF block rule for a domain/IP pair. Use when blocking malicious traffic." | Verb+object, explicit when-to-use, param hints |
| "Queries the last N access log entries for a domain. Use for incident triage, not analytics." | Scoped use case, prevents misuse |
| "Sets a per-domain rate limit in req/s. Use when throttling abusive clients on a specific domain." | Quantified, scoped |

**Bad examples**:

| Description | Why bad |
|---|---|
| "Manage firewall" | Too vague — LLM won't know when to select this vs others |
| "Execute admin action on osh_admin" | Generic — LLM will hallucinate params |
| "Does stuff with rate limits" | No verb clarity, no when-to-use |

LLM tool selection is entirely description-driven. Vague descriptions cause wrong tool selection or missed invocations.

---

## param_schema best practices

Always use JSON Schema with these constraints:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["domain"],
  "properties": {
    "domain": {
      "type": "string",
      "description": "Target domain (FQDN, e.g. foo.com). Required."
    },
    "limit_rps": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10000,
      "description": "Rate limit in requests per second."
    },
    "action": {
      "type": "string",
      "enum": ["block", "challenge", "log"],
      "description": "WAF action. Default: block."
    }
  }
}
```

Rules:

- `additionalProperties: false` — always. Prevents LLM injecting unexpected fields that pass through to upstream
- `required` — list every field the upstream endpoint actually requires
- Use `enum` for any field with a finite value set — stops LLM hallucinating invalid values
- Add `description` on every property — this is the LLM's only hint for how to populate the field
- Use `format: "date-time"` for ISO timestamps, `minimum`/`maximum` for integers
- Avoid `type: "object"` nested args unless the upstream schema truly requires it — flat schemas = better LLM fill

---

## Permission naming convention

Pattern: `<app_slug>:tool.<snake_case_verb_noun>`

Examples:
- `osh_admin:tool.create_waf`
- `osh_admin:tool.create_rate_limit`
- `osh_admin:tool.query_access_log`
- `gitlab:tool.create_merge_request`

**Ownership**: the upstream app (`osh_admin`) owns and enforces permissions via its own RBAC integration. OneMCP forwards `X-Onemcp-User-Sub` — the upstream decides allow/deny. OneMCP does NOT duplicate the permission check.

**Registration**: permissions are registered in Central RBAC by the upstream app's team, not OneMCP team.

---

## Security checklist

Complete before enabling a tool for users:

- [ ] Bearer token stored in OneMCP DB encrypted (via Admin UI — never in `.env` or compose)
- [ ] Upstream URL uses HTTPS in prod (HTTP only acceptable on private docker network)
- [ ] No user-supplied input is interpolated into URL path segments unescaped (only query params / JSON body)
- [ ] Upstream response does not leak stack traces or internal credentials (verify with dry-run test-call)
- [ ] `timeout_ms` set to a value that prevents hanging sessions (recommend ≤15000ms)
- [ ] `response_max_bytes` cap configured (prevents 10MB upstream dumps crashing Claude context)
- [ ] Tool dry-run tested with all test users (allow + deny paths verified)
- [ ] Permission assigned only to intended roles — verify in Central RBAC UI before enable

---

## Anti-patterns

| Anti-pattern | Problem | Fix |
|---|---|---|
| `execute_command` with free-form `cmd` string arg | Arbitrary code exec surface, LLM will hallucinate dangerous commands | Define specific tools for each operation |
| Single `query` string arg on all tools | LLM must guess format; upstream gets unparseable input | Structured params per field |
| `enabled: true` before dry-run test | First user call hits untested path | Always test-call first |
| Reusing one tool for multiple operations via a `mode` param | LLM can't distinguish tools; description becomes unmaintainable | One tool = one operation |
| No `description` on params | LLM fills fields with plausible-looking wrong values | Every param needs a description |
| `additionalProperties: true` or omitted | LLM injects fields that leak to upstream silently | Always `additionalProperties: false` |
| bearer in `docker-compose.yml` as env var | Token in git history | Use OneMCP Admin UI — encrypted at rest |
