# Open WebUI Blind LLM Arena API Research

**Date:** 2026-07-28  
**Scope:** Pipe + Action APIs for blind model A/B comparison with vote capture  
**Deployment:** Open WebUI 0.10.x (prod/lab) with LiteLLM proxy backend

---

## 1. Pipe Function API

### Class Shape & Method Signature

```python
class Pipe:
    class Valves(BaseModel):
        param1: str = Field(default="value", description="...")
    
    def __init__(self):
        self.valves = self.Valves()
    
    async def pipe(
        self, 
        body: dict,  # OpenAI-compat chat completion request
        __user__: Optional[dict] = None,
        **kwargs
    ) -> Union[str, AsyncGenerator[str, None]]:
        # body.get("messages") = conversation history
        # body.get("model") = model_id user selected
        return "response" or yield "streamed_chunk"
```

**Key Points:**
- `pipe()` is **async-preferred** (sync still works, but async mandatory for future compat)
- Returns `str` (single response) or `AsyncGenerator[str, None]` (streaming SSE chunks)
- `body` is OpenAI `/chat/completions` request object (dict with `messages`, `model`, etc.)
- Valve fields persist across calls; no secrets here (visible in UI settings)
- `__user__` = OpenWebUI user context (id, email, name, role) — OK to use for auth

**Streaming Caveat:** Open WebUI #20196 — returning AsyncGenerator can hang UI if not properly chunked. Yield plain strings (treated as assistant content) or OpenAI SSE dict `{"choices": [{"delta": {"content": "..."}}]}` format.

---

## 2. Calling Another Model from Pipe

**Problem:** How to invoke `claude-sonnet`, `deepseek` internally (not HTTP)?

**Solution:** Import and call `generate_chat_completions()` from `open_webui.utils.chat`:

```python
from open_webui.utils.chat import generate_chat_completions

async def pipe(self, body: dict, **kwargs):
    # Call model B while processing model A request
    model_b_request = {
        "model": "deepseek",  # registered model name in LiteLLM
        "messages": [...],
        "stream": True,  # or False for single response
        "temperature": 0.7,
        "top_k": 40,
        "top_p": 0.9,
    }
    
    # generate_chat_completions is async
    response = await generate_chat_completions(
        self.__request__,  # FastAPI request context
        model_b_request,
        user=self.__user__,
    )
    
    # If stream=True, response is async generator → iterate
    if model_b_request["stream"]:
        async for chunk in response:
            # chunk is SSE dict {"choices": [{"delta": {"content": "..."}}]}
            yield json.dumps(chunk)  # relay to client as-is
    else:
        # Single response
        return response.get("choices")[0]["message"]["content"]
```

**Access to `self.__request__`:** Injected by Open WebUI at runtime. Available in `pipe()` context.

**For blind arena:** Call `generate_chat_completions(... model="A")` and `generate_chat_completions(... model="B")` sequentially or async-parallel, buffer outputs, then combine without revealing model names in streamed chunks.

---

## 3. Action Function — Message Editing & Reveal

### Class Shape

```python
class Action:
    class Valves(BaseModel):
        param1: str = Field(...)
    
    def __init__(self):
        self.valves = self.Valves()
    
    async def action(
        self,
        body: dict,  # Full chat context (messages, model, user, etc.)
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[Callable] = None,
        __event_call__: Optional[Callable] = None,
    ) -> Optional[str]:
        # body["messages"] = list of {role, content}
        # body["messages"][-1] = last assistant message
        return "optional_return_value"
```

### Reading Message Content

```python
# Get last assistant message (the one with blind response)
messages = body.get("messages", [])
for msg in reversed(messages):
    if msg.get("role") == "assistant":
        last_content = msg.get("content", "")
        break
```

### Appending / Editing via `__event_emitter__`

**Can Actions edit existing messages?** 
- **No direct edit.** Cannot mutate `body["messages"][-1]` and persist it back.
- **Yes, append new message via event emitter:**

```python
async def action(self, body, __event_emitter__=None, ...):
    # Option 1: Append new assistant message
    if __event_emitter__:
        await __event_emitter__({
            "type": "message",
            "data": {"content": "A was **claude-sonnet**\nB was **deepseek**"}
        })
    
    # Option 2: Status/progress indicator
    await __event_emitter__({
        "type": "status",
        "data": {"description": "Revealing models...", "done": False}
    })
```

**Event Types Supported:**
- `"message"` — append new chat message (appears below current message)
- `"status"` — progress indicator (header bar, auto-clears when `done: true`)
- `"notification"` — toast (success/warning/error/info in corner)
- `"source"` — citation metadata (`{"document": {...}, "source": ...}`)

---

## 4. Hiding Model Names in Blind Phase

### Option A: HTML Comment (⚠️ Not Hidden)
```markdown
<!-- A=claude-sonnet, B=deepseek -->
Response text here...
```
**Problem:** Visible in "View Page Source" or DevTools. Not secure.

### Option B: Markdown YAML Frontmatter (Better)
```markdown
---
model_a: claude-sonnet
model_b: deepseek
vote_metadata: arena-2026-07-28
---

Response text here...
```
**Limitation:** Open WebUI strips frontmatter on render, but stored in raw message. Action can parse `body["messages"][-1]["content"]` to extract YAML header, then strip before display.

### Option C: Message Metadata Field (Best — Future)
Open WebUI #19594 requests persistent "invisible metadata object" in chat history. Currently **not implemented**. When available:
```python
{
    "role": "assistant",
    "content": "Blind response...",
    "_metadata": {  # proposed (not yet in OpenWebUI API)
        "model_a": "claude-sonnet",
        "model_b": "deepseek",
        "vote_key": "msg-12345"
    }
}
```

### Option D: Separate Vote Lookup by Message ID (Pragmatic)
- Pipe appends `message_id` **in markdown comment** to the response
- Action extracts `message_id` from content
- Action looks up pair (A, B) from JSONL file using `message_id`
- Returns reveal + vote buttons
- **Avoids storing secrets in message body**

---

## 5. Storing Votes in JSONL (Persistence)

### Persistent Volume

From docker-compose.yml (line 517):
```yaml
volumes:
  - ./data/openwebui:/app/backend/data
```

**Inside container:** `/app/backend/data/` → mounted from host `./data/openwebui/`

**Write location:** Safe to write to `/app/backend/data/votes.jsonl` or similar. 
- Survives container restart
- Shared across sessions
- ⚠️ **No built-in cleanup** (JSONL appends forever)

### JSONL Schema for Blind Arena Votes

```json
{"timestamp": "2026-07-28T10:30:00Z", "user": "user123", "chat_id": "abc-def", "message_id": "msg-999", "vote": "A", "vote_key": "blind-arena-1", "model_a": "claude-sonnet", "model_b": "deepseek"}
{"timestamp": "2026-07-28T10:31:00Z", "user": "user123", "chat_id": "abc-def", "message_id": "msg-999", "vote": "B", ...}
{"timestamp": "...", ...}
```

### Write from Action

```python
import json
from pathlib import Path
from datetime import datetime, timezone

async def action(self, body, ...):
    votes_path = Path("/app/backend/data/blind-arena-votes.jsonl")
    
    message_id = extract_message_id_from_content(...)
    vote_record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "user": __user__.get("id"),
        "chat_id": body.get("chat_id"),
        "message_id": message_id,
        "vote": "A",  # user selected A/B/Tie/Both-bad
        "model_a": "claude-sonnet",
        "model_b": "deepseek",
    }
    
    # Append (append-only, no locking — OK for single-replica)
    with open(votes_path, "a") as f:
        f.write(json.dumps(vote_record) + "\n")
```

**Caveat:** No distributed locking. For multi-replica OpenWebUI, use a database (Postgres in legacy setup, now decommissioned). For PoC, append-only is acceptable.

---

## 6. Model Selection in UI

**Where does user pick Pipe model name?**

1. Admin → Workspace → Models → Import/Create
2. Pipe registers via `self.type` (auto-detected from class name or explicit)
3. Model appears in chat model dropdown
4. User selects → sends request with `body["model"] = "PipeName"`

For blind arena:
- Create Pipe class `BlindArena` → registers as model "blind-arena"
- User selects "blind-arena" in dropdown
- Pipe gets `body["model"] == "blind-arena"`
- Inside `pipe()`, ignore `model` param; hardcode call to A & B

**Valves UI:** 
- Define `Valves` class fields
- Auto-render as form in Admin → Workspace → Models → [BlindArena] → ⚙️ Settings
- User can adjust `MODEL_A`, `MODEL_B`, etc. at runtime

---

## 7. Architecture Constraints & Adoption Risk

### Supported Versions
- **Deployment:** Open WebUI 0.10.x (lab: onelog-source, prod: onelog-vps)
- **Async Pipes:** Required for multi-model invoke without blocking
- **Event Emitter Bugs:** #8292, #8840 — fixed in 0.11.0+. May need workarounds in 0.10.x (e.g., return string instead of relying on __event_emitter__)

### Maturity
- Pipe API: **Stable** (in use since 0.8+)
- `generate_chat_completions` import: **Stable** (internal utility, unlikely to break)
- Action `__event_emitter__`: **Stable but buggy** (use sparingly; prefer return value)
- Metadata persistence: **Not implemented** (blocking issue #19594)

### Workarounds for 0.10.x
- Avoid `__event_emitter__` for appending; instead return full response (A/B + reveal) in single message
- Use markdown comment `<!-- vote_key=XXX -->` instead of metadata field
- Test streaming output early (may need manual chunk structuring for stability)

---

## 8. Calling Other Models in Parallel

For efficient blind comparison, invoke A & B concurrently:

```python
import asyncio
from typing import AsyncGenerator

async def pipe(self, body: dict, **kwargs) -> AsyncGenerator[str, None]:
    request_a = {"model": "claude-sonnet", "messages": [...], "stream": False}
    request_b = {"model": "deepseek", "messages": [...], "stream": False}
    
    # Parallel execution
    tasks = [
        generate_chat_completions(self.__request__, request_a, user=self.__user__),
        generate_chat_completions(self.__request__, request_b, user=self.__user__),
    ]
    responses = await asyncio.gather(*tasks)
    
    response_a = responses[0]["choices"][0]["message"]["content"]
    response_b = responses[1]["choices"][0]["message"]["content"]
    
    # Shuffle & blind (randomize which is A/B to user)
    import random
    order = random.choice(["ab", "ba"])
    if order == "ab":
        first, second = response_a, response_b
        mapping = {"first": "claude-sonnet", "second": "deepseek"}
    else:
        first, second = response_b, response_a
        mapping = {"first": "deepseek", "second": "claude-sonnet"}
    
    # Return blinded output + store mapping for vote action
    # (use message_id or YAML frontmatter to stash mapping)
    yield f"**Option 1:**\n{first}\n\n**Option 2:**\n{second}"
```

---

## Summary: Implementation Path

| Component | Technology | Notes |
|-----------|-----------|-------|
| **Blind Response** | Pipe (async) + `generate_chat_completions` | Parallel invoke A/B, shuffle order |
| **Hide Pair** | YAML frontmatter in message OR message_id → JSONL lookup | Until metadata API ships |
| **Reveal + Vote** | Action function + `__event_emitter__` | Append reveal message + vote buttons |
| **Vote Storage** | JSONL append to `/app/backend/data/blind-arena-votes.jsonl` | No locking; single-replica OK |
| **Version Constraint** | Open WebUI 0.10.x + LiteLLM proxy | Event emitter bugs known; minimal workarounds needed |

---

## Unresolved Questions

1. **Multi-model parallel latency:** Will `asyncio.gather()` timeout if A takes 30s and B takes 5s? Need to test with real provider latency.
2. **Streaming + blind shuffle:** How to stream first/second responses without buffering entire outputs? Current design buffers → may OOM on long outputs.
3. **Vote persistence across sessions:** Should votes be tied to chat_id or standalone? If chat is deleted, should votes be archived?
4. **Tie/Both-bad vote buttons:** How to render these as Action buttons? May require custom HTML via `__event_emitter__` (not tested).
5. **User attribution:** If `__user__` is None (anonymous), how to track vote origin? Fallback to session ID or IP?

Sources:
- [Pipe Function / Open WebUI](https://docs.openwebui.com/features/extensibility/plugin/functions/pipe/)
- [Action Function / Open WebUI](https://docs.openwebui.com/features/extensibility/plugin/functions/action/)
- [Events / Open WebUI](https://docs.openwebui.com/features/extensibility/plugin/development/events/)
- [Support Async Pipes · open-webui/open-webui · Discussion #10565](https://github.com/open-webui/open-webui/discussions/10565)
- [Open WebUI hangs streaming when pipe returns AsyncGenerator · Issue #20196](https://github.com/open-webui/open-webui/issues/20196)
- [Can I append an Assistant message after triggering Action? · Discussion #8274](https://github.com/open-webui/open-webui/discussions/8274)
- [Persistent Metadata Object · Issue #19594](https://github.com/open-webui/open-webui/issues/19594)
- [Multi Model Conversations Pipe Function](https://openwebui.com/f/haervwe/multi_model_conversations_pipe)
