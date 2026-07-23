# Phase 2 — OpenWebUI Function (search) + Action (submit button)

## Priority
High. Bridge chính của toàn hệ thống.

## Decision (2026-07-23 13:24)
**Chọn Path B duy nhất**: OpenWebUI Function + Action. Bỏ mcpo bridge path vì cần identity passthrough per-request.

## Requirements

### Component 1 — Function `onemcp-search.py` (LLM-callable tools)
File: `infra/openwebui/functions/onemcp-search.py`

Exposes 2 tools LLM tự gọi:
- `onemcp_search(query, limit=10)` — search KB, **hardcode filter `status=published`** để chỉ trả verified entries
- `onemcp_get(artifact_id)` — fetch full artifact khi user muốn xem chi tiết

Key implementation:
```python
class Tools:
    class Valves(BaseModel):
        ONEMCP_URL: str = "http://192.168.122.56"
        BOT_USER: str = "openwebui-bot"
        VERIFY_TLS: bool = True  # V2: default TRUE, CA cert mounted vào openwebui (Phase 1 gate)

    async def _rpc(self, method, params):
        user_hdr = self.valves.BOT_USER
        async with httpx.AsyncClient(verify=self.valves.VERIFY_TLS, timeout=30) as c:
            r = await c.post(
                f"{self.valves.ONEMCP_URL}/api/mcp",
                json={"jsonrpc":"2.0","id":1,"method":method,"params":params},
                headers={"X-Onemcp-User": user_hdr},
            )
            return r.json().get("result", {})

    async def onemcp_search(self, query: str, limit: int = 10, _ignored=None) -> str:
        """Search OneMCP KB (published only, verified). Vietnamese unaccent-aware FTS + trigram."""
        return await self._rpc("tools/call", {
            "name":"search",
            "arguments":{"q":query,"limit":limit,"status":"published"}
        }, __user__)

    async def onemcp_get(self, artifact_id: str, _ignored=None) -> str:
        """Fetch full artifact by ID."""
        return await self._rpc("tools/call", {"name":"get_artifact","arguments":{"id":artifact_id}}, __user__)
```

### Component 2 — Action `onemcp-submit-kb.py` (button per message)
File: `infra/openwebui/actions/onemcp-submit-kb.py`

Xuất hiện dưới mỗi assistant message: **📚 Save to KB**.

Flow khi user click:
1. Action nhận `body` = full chat messages + `__user__`
2. Gọi LLM cheap (deepseek qua OpenWebUI's internal completion API) tóm tắt transcript → JSON `{title, body, tags, service}`
3. Return **modal form** (OpenWebUI Action native support): các field editable
4. User edit + click "Submit KB" → Action nhận filled form
5. Redact secrets (regex quick)
6. POST OneMCP `submit_artifact(type=kb, ...)` với `X-Onemcp-User = __user__.email`
7. Return toast: "✅ KB #123 pending — verify tại portal: {link}"

Key skeleton:
```python
class Action:
    class Valves(BaseModel):
        ONEMCP_URL: str = "https://onemcp.local"
        SUMMARIZER_MODEL: str = "deepseek"

    async def action(self, body: dict, __user__: dict, __event_emitter__, __event_call__):
        # Stage 1: summarize
        transcript = "\n".join(m["content"] for m in body["messages"])
        draft = await self._summarize(transcript)  # calls internal LLM

        # Stage 2: modal preview via __event_call__ input request
        edited = await __event_call__({
            "type": "input",
            "data": {"title": "Save to KB", "fields": [
                {"name":"title","value":draft["title"]},
                {"name":"tags","value":",".join(draft["tags"])},
                {"name":"service","value":draft["service"]},
                {"name":"body","value":draft["body"],"multiline":True}
            ]}
        })
        if not edited: return

        # Stage 3: submit
        result = await self._submit(edited, __user__)
        await __event_emitter__({"type":"status","data":{"description":f"KB #{result['id']} pending — {result['url']}"}})
```

**Note**: OpenWebUI Action modal API name (`__event_call__` with `type:input`) — verify against installed OpenWebUI version trong Phase 1. Nếu version cũ không support → fallback: submit thẳng không preview (accept trade-off).

### Component 3 — Docs cho admin install
File: `infra/openwebui/README.md`

Screenshot + steps:
1. Admin → Workspace → Functions → Import → paste `onemcp-search.py` → enable
2. Admin → Workspace → Actions → Import → paste `onemcp-submit-kb.py` → enable
3. Set Valves: ONEMCP_URL, VERIFY_TLS
4. Kiểm tra: mở chat mới, thử "test", xem tool list có `onemcp_search`

## Files to create
- `infra/openwebui/functions/onemcp-search.py`
- `infra/openwebui/actions/onemcp-submit-kb.py`
- `infra/openwebui/README.md`

## Files to modify
- `infra/.env.example` — thêm `ONEMCP_URL`, `ONEMCP_VERIFY_TLS`
- `infra/docker-compose.yml` — openwebui service thêm `extra_hosts: ["onemcp.local:<IP>"]` nếu cần

## Todo
- [ ] Xác nhận OpenWebUI version (Phase 1 output) → verify Action `__event_call__ type:input` supported
- [ ] Viết Function `onemcp-search.py` với published filter + user identity
- [ ] Viết Action `onemcp-submit-kb.py` với summarizer + modal + submit
- [ ] Admin install cả 2 vào OpenWebUI + set Valves
- [ ] Manual test: chat "test", xem LLM có gọi được `onemcp_search`
- [ ] Manual test: click 📚 button dưới message, xem modal hiện + submit thành công
- [ ] Verify OneMCP portal thấy entry pending với contributor = real user email

## Success criteria
- LLM có `onemcp_search`, `onemcp_get` khả dụng
- Action button 📚 xuất hiện dưới mỗi assistant message
- Click button → modal preview → user edit → submit → entry pending trong OneMCP portal với đúng user attribution
- Nếu OneMCP unreachable: LLM tool call fail gracefully, Action toast "OneMCP không kết nối được"

## Risks
- **OpenWebUI Action modal API** (`__event_call__ type:input`) chưa stable / khác version → fallback submit không preview. **Verify Phase 1**.
- **`__user__` field naming** giữa OpenWebUI versions khác nhau (`__user__.email` vs `.name` vs `.username`) → dùng chain fallback trong `_rpc()`.
- **Summarizer latency** làm user chờ 3-5s trước khi modal hiện → hiển thị loading indicator qua `__event_emitter__`.
- **CORS / TLS self-signed** giữa openwebui container và OneMCP → mount CA hoặc `VERIFY_TLS=false` cho lab.

## Security (updated V2, V3 — 2026-07-23)
- Không log full transcript (privacy) — chỉ log bot user + artifact_id
- Role trong OneMCP: bot contributor → submit pending, không auto-publish

### V3 Redact enforcement (BEFORE summarizer call)
Module `redact.py` với 2 tier:
- **Hard block** (raise exception, không submit):
  - PEM headers: `-----BEGIN (RSA )?PRIVATE KEY-----`, `-----BEGIN OPENSSH PRIVATE KEY-----`
  - SSH keys: `ssh-rsa AAAA[A-Za-z0-9+/=]{200,}`
  - AWS/GCP secrets: `AKIA[0-9A-Z]{16}`, `AIza[0-9A-Za-z_-]{35}`
  - OpenAI keys: `sk-[A-Za-z0-9]{20,}`
  - JWT hình như secret: `eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}`
- **Soft redact** (replace by `<REDACTED_*>`):
  - IPv4 private: `10\.`, `172\.(1[6-9]|2\d|3[01])\.`, `192\.168\.` → `<REDACTED_PRIVATE_IP>`
  - IPv4 public → `<REDACTED_IP>`
  - Emails ngoài `@inet.vn` → `<REDACTED_EMAIL>`
  - Path chứa `.env`, `id_rsa`, `credentials.json` → `<REDACTED_PATH>`
Apply thứ tự: hard block check trước → nếu clean, soft redact → truyền vào summarizer + submit.
Unit test: 6+ cases (positive + negative) trong `tests/test_redact.py`.

## Next
Phase 3: system prompt (search-first + nhắc nút Save to KB).
