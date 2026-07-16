# OneLog System Architecture

High-level overview of OneLog RAG log server. Single-node MVP with HA roadmap (see `ha-roadmap.md`).

**Last updated:** 2026-07-16

---

## System Diagram (MVP)

```
┌─────────────────────────────────────────────────────────────────┐
│ CLIENT VMs (srv-01, srv-02, ..., srv-N)                         │
│  rsyslog / vector-agent                                         │
│  RFC5424 syslog TCP 6514                                        │
└──────────────┬──────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────┐
│ LOGSERVER (single-node lab, docker compose)                      │
│                                                                   │
│ ┌─────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│ │ Vector      │  │ VictoriaLogs    │  │ NATS JetStream      │  │
│ │ (514 UDP,   │→ │ (syslog ingest) │→ │ (LOGS stream)       │  │
│ │  6514 TCP)  │  │ (9428 logsql)   │  │                     │  │
│ └─────────────┘  └─────────────────┘  └────────┬────────────┘  │
│                                                  │               │
│                                    ┌─────────────▼──────────┐   │
│                                    │ Indexer Worker         │   │
│                                    │ (Drain3 + embed)       │   │
│                                    │ (OpenAI embed)         │   │
│                                    └─────────────┬──────────┘   │
│                                                  │               │
│ ┌─────────────────────────────────────────────────▼──────────┐  │
│ │ Qdrant Vector Store                                        │  │
│ │ Collections:                                               │  │
│ │  - log_templates (Drain3 consolidated patterns)            │  │
│ │  - kb_resolved (Knowledge Base entries, Phase 1)           │  │
│ │ (6333 internal, 1536 dims, Cosine distance)                │  │
│ └──────────────────────────────────────────────────────────┬─┘  │
│                                                              │    │
│ ┌─────────────────┐  ┌──────────────┐  ┌──────────────────▼┐   │
│ │ Postgres        │  │ Redis        │  │ Agent (FastAPI)   │   │
│ │ (conversations, │  │ (cache TBD)  │  │ (SSE chat, tools) │   │
│ │  messages,      │  │              │  │ (LLM: DeepSeek,   │   │
│ │  audit_log,     │  │              │  │  Anthropic, etc)  │   │
│ │  kb_entries,    │  │              │  │                   │   │
│ │  kb_edits,      │  │              │  │ MCP:              │   │
│ │  kb_taxonomy)   │  │              │  │ - mcp-vl (logsql) │   │
│ │ (5432 internal) │  │              │  │ - mcp-semantic    │   │
│ └─────────────────┘  └──────────────┘  │ (8080 backend)    │   │
│                                          └───────┬──────────┘   │
│ ┌──────────────────────────────────────────────────▼────────┐   │
│ │ Caddy (Reverse Proxy)                                      │   │
│ │ 80, 443 (IP whitelist LAN)                                 │   │
│ │ Routes:                                                    │   │
│ │  / → web (Next.js)                                         │   │
│ │  /api/* → agent (FastAPI)                                  │   │
│ │  /select/* → VictoriaLogs (vmui + logsql API)              │   │
│ │  /qdrant/* → Qdrant (vector API)                           │   │
│ └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────┐
│ CLIENT BROWSERS / TOOLS                                           │
│ Next.js web UI (chat, KB search — Phase 2)                        │
│ vmui (VictoriaLogs QUERY UI, direct)                              │
│ Claude Code / MCP clients                                         │
└──────────────────────────────────────────────────────────────────┘
```

---

## Data Flow (Chat Search → Answer)

```
1. User enters query in web chat
   ↓
2. Next.js SSE client → POST /api/chat {query}
   ↓
3. Agent (FastAPI) receives query
   ├─ Tool 1: search_log_templates (via mcp-semantic)
   │  └─ Embed query → Qdrant search log_templates collection → top-5 matches
   │
   ├─ Tool 2: run_logsql (via mcp-vl)
   │  └─ Query VictoriaLogs logsql API → raw logs matching top templates
   │
   ├─ Tool 3: get_raw_lines (via mcp-vl)
   │  └─ Fetch adjacent log lines for context
   │
   └─ Tool 4: search_kb (future Phase 2)
      └─ Embed query → Qdrant search kb_resolved collection → KB matches
         (each KB match links back to originating conversation)
   ↓
4. LLM (Claude Sonnet / DeepSeek) reasons over cited evidence
   └─ Returns answer with tool citations (SSE streaming)
   ↓
5. Agent saves conversation + messages + tool_calls to Postgres
   ├─ conversations.id (uuid)
   ├─ messages (text, role, created_at)
   ├─ messages.parts (jsonb: tool_call events + results with citations)
   └─ audit_log (entry per tool call + LLM tokens for cost tracking)
```

---

## Knowledge Base (KB) Flow — Phase 1 (2026-07-16)

```
┌──────────────────────────────────────────────────────────────────┐
│ Chat Conversation Resolved                                        │
│ (member read through VL logs + agent chat → found root cause)     │
└──────────────────────────────────────────┬───────────────────────┘
                                           │
                                           ▼
                        ┌─────────────────────────────────┐
                        │ "Mark Resolved" Button (Chat UI) │
                        └────────────┬────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────────┐
                    │ POST /api/kb/summarize              │
                    │ Input: {conversationId}             │
                    └────────────┬────────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────────────────┐
                    │ Extract Evidence from Chat:        │
                    │ - messages.parts (tool_calls)      │
                    │ - assistant messages (citations)   │
                    │ (Grounding: no hallucination)      │
                    └────────────┬─────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────────────────┐
                    │ LLM Prompt (DeepSeek/Haiku):       │
                    │ Extract:                           │
                    │ {                                  │
                    │   title, symptom, root_cause, fix, │
                    │   department, topic, issue_type,   │
                    │   tags[]                           │
                    │ }                                  │
                    └────────────┬─────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────────────────┐
                    │ Taxonomy Snap (Dedup by value):    │
                    │ - Fuzzy Levenshtein ≥0.85 → snap  │
                    │ - Semantic embed cosine ≥0.85     │
                    │ - Else: INSERT new taxonomy value  │
                    │ (Prevents disk-full vs ENOSPC etc) │
                    └────────────┬─────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────────────────┐
                    │ Return Draft Entry to Member       │
                    │ (UI modal: edit before confirm)    │
                    └────────────┬─────────────────────┘
                                 │
                          ┌──────┴──────┐
                          │ Member Edit │ (optional)
                          └──────┬──────┘
                                 │
                                 ▼
                    ┌────────────────────────────────────┐
                    │ POST /api/kb/entries                │
                    │ Input: {entry payload}             │
                    └────────────┬─────────────────────┘
                                 │
                    ┌────────────┴──────────────────┐
                    │ Redact PII (before embed):   │
                    │ - IP patterns                │
                    │ - Hostnames (if marked PII)  │
                    │ - Email addresses            │
                    │ (Reuse agent/redact.py)      │
                    └────────────┬──────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────────────────┐
                    │ Embed (OpenAI embed model):        │
                    │ text = title + " " + symptom +     │
                    │        " " + root_cause            │
                    │ → 1536 dims (matches Qdrant)       │
                    └────────────┬─────────────────────┘
                                 │
                    ┌────────────┴────────────────────┐
                    │ Semantic Dedup Check (Qdrant):  │
                    │ Search kb_resolved collection:  │
                    │ If top-1 cosine >0.9:           │
                    │   → Return dedup hits           │
                    │      (member: merge/upvote/    │
                    │       force create)             │
                    └────────────┬──────────────────┘
                                 │
                    ┌────────────┴────────────────────┐
                    │ INSERT into Postgres:           │
                    │ - kb_entries (all fields)       │
                    │ - INCREMENT kb_taxonomy usage   │
                    │ + UPSERT Qdrant point:          │
                    │   id=embedding_id, vector      │
                    │   (atomic Postgres + Qdrant)   │
                    └────────────┬──────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────────────────┐
                    │ Success Response:                  │
                    │ {id, embedding_id}                │
                    │ (or dedup prompt if >0.9 match)   │
                    └────────────────────────────────────┘
```

---

## Database Schema (Postgres)

### Conversations & Messages
```sql
conversations(
  id uuid pk,
  title varchar(200),
  created_by int fk users(id),
  created_at timestamptz,
  updated_at timestamptz,
  is_archived bool default false
)

messages(
  id uuid pk,
  conversation_id uuid fk conversations(id),
  role varchar(32),        -- 'user', 'assistant'
  text text,
  parts jsonb,             -- [{type: 'text'|'tool_call'|'tool_result', ...}]
  created_at timestamptz
)

audit_log(
  id uuid pk,
  conversation_id uuid fk conversations(id),
  tool_name varchar(64),   -- search_log_templates, run_logsql, etc.
  tool_input jsonb,
  tool_output jsonb,
  input_tokens int,
  output_tokens int,
  cost_usd decimal(10,6),
  created_at timestamptz
)
```

### Knowledge Base (Phase 1)
```sql
kb_entries(
  id uuid pk,
  conversation_id uuid fk conversations(id) on delete set null,  -- nullable (manual entries)
  title varchar(200) not null,
  department varchar(32),   -- SRE, DBA, NetOps, AppDev, Security, ...
  topic varchar(64),        -- mysql, rsyslog, vmalert, disk, ssh, ...
  issue_type varchar(64),   -- disk-full, brute-force, oom, crash-loop, ...
  tags text[],              -- free-form: host, service, error code, ...
  symptom text,             -- triệu chứng nhận biết
  root_cause text,          -- nguyên nhân gốc
  fix text,                 -- cách xử lý
  embedding_id varchar(128) not null,  -- Qdrant point id
  created_by int fk users(id),
  upvotes int default 0,
  verified_by int[],        -- [user_id, ...] (who verified)
  created_at timestamptz,
  updated_at timestamptz
)

kb_edits(
  id uuid pk,
  entry_id uuid fk kb_entries(id) on delete cascade,
  user_id int fk users(id),
  diff_json jsonb,          -- {field: {before: ..., after: ...}, ...}
  edited_at timestamptz
)

kb_taxonomy(
  kind varchar(16),         -- 'department', 'topic', 'issue_type'
  value varchar(64),
  usage_count int default 1,
  primary key(kind, value)
)
```

---

## Vector Store (Qdrant)

### Collections

**log_templates** (existing, used by log search)
- Dimensions: 1536 (OpenAI embed)
- Distance metric: Cosine
- Points: consolidated Drain3 log templates
- Payload: {service, host, pattern, count, last_seen}

**kb_resolved** (new, Phase 1)
- Dimensions: 1536 (same as log_templates)
- Distance metric: Cosine
- Points: KB entry embeddings
- Payload: {entry_id, conversation_id, title, department, topic, issue_type, tags, created_at}

---

## Environment Variables

### KB Phase 1 (deployed 2026-07-16)

```env
# LLM Summarization
DEEPSEEK_API_KEY=sk-deepseek-...
KB_SUMMARIZE_MODEL=deepseek-chat

# Embeddings
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
EMBED_MODEL=text-embedding-3-small

# Vector Store
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=...
KB_QDRANT_COLLECTION=kb_resolved

# KB Thresholds (tunable)
KB_DEDUP_THRESHOLD=0.9        # semantic dedup cosine
KB_SNAP_THRESHOLD=0.85        # taxonomy snap fuzzy+semantic
KB_LLM_MOCK=false             # mock mode for dev/CI
KB_BACKFILL_RPM=5             # backfill rate (optional)
```

---

## Service Interactions (MCP)

**mcp-vl** (MCP wrapper for VictoriaLogs)
- Tools: `run_logsql(query)`, `get_raw_lines(service, offset, limit)`
- Protocol: MCP (JSON-RPC over stdio or HTTP)
- Used by: Agent `/chat` endpoint

**mcp-semantic** (MCP wrapper for embeddings + Qdrant)
- Tools: `search_log_templates(query, limit)`, `search_kb(query, limit, filters)`
- Protocol: MCP
- Used by: Agent `/chat` endpoint

**Agent (FastAPI)** — orchestrates MCP tools + LLM reasoning
- SSE chat endpoint: `/chat` (POST, streaming response)
- KB endpoints: `/api/kb/summarize` (POST), `/api/kb/entries` (POST, PATCH)
- Internal only (via Caddy `/api/*`)

---

## Scaling Strategy (See ha-roadmap.md)

**MVP (single-node):**
- All services on 1 docker compose stack
- ~5k logs/sec throughput (Indexer bottleneck)

**Phase 02 (multi-node):**
- VL cluster (vlinsert → vlstorage × 2 → vlselect)
- Qdrant cluster (3 node, replicas=2)
- Postgres primary + replica
- NATS cluster (3 node) with JetStream replicas=3
- Indexer × N sharing Drain3 state via Redis
- Agent × N behind LB, Redis semantic cache

**Trigger:** Thresholds in `ha-roadmap.md` § Khi nào migrate.

---

## Deployment Notes

- **Infrastructure:** `infra/docker-compose.yml` + profile system (`--profile agent --profile mcp --profile alerts --profile indexer`)
- **Config:** `infra/.env` (secrets + API keys)
- **Reverse proxy:** Caddy (TLS, routing, IP whitelist for lab)
- **Init:** Scripts in `infra/scripts/` (setup, healthcheck, snapshot, restore)
- **Systemd:** Auto-restart on host reboot

See `deployment-guide.md` for detailed setup.

---
