"""
wrapup-prompts.py — Classifier + Extractor prompts + Gatekeeper for session wrap-up.

Consumed by: infra/openwebui/actions/onemcp-wrapup.py (Phase 3)
Test: infra/openwebui/actions/wrapup-prompts-test.py

Design principles:
- VN-first prompts (80% chat VN). Auto-detect EN via latin-char ratio heuristic.
- Classifier biased toward SKIP over misclassify.
- Extractors include example output + "chỉ từ transcript, không invent" instruction.
- Gatekeeper runs locally (no LLM) — pure rule checks.
- Prompt token budget: each < 1500 tokens (~6000 chars rough estimate).
"""

import json
import re
from typing import Any, Callable


# ============================================================================
# Language detection
# ============================================================================

def _is_english_transcript(transcript: str) -> bool:
    """Heuristic: if >55% chars are ASCII alpha → treat as EN transcript.
    Threshold 55% because VN text still uses many ASCII chars (spaces, numbers, code)."""
    if not transcript:
        return False
    alpha_chars = [c for c in transcript if c.isalpha()]
    if not alpha_chars:
        return False
    ascii_alpha = sum(1 for c in alpha_chars if ord(c) < 128)
    return (ascii_alpha / len(alpha_chars)) > 0.55


def _lang_note(transcript: str) -> str:
    """Return language instruction suffix for prompts."""
    if _is_english_transcript(transcript):
        return "LANGUAGE: Transcript is EN → write output in English."
    return "NGÔN NGỮ: Transcript là tiếng Việt → viết output bằng tiếng Việt có dấu. Giữ nguyên EN cho technical terms (service names, commands, config keys, error codes, HTTP verbs, log keywords)."


# ============================================================================
# CLASSIFIER_PROMPT
# ============================================================================

CLASSIFIER_PROMPT_VN = """Bạn là classifier phân loại chat session để lưu vào knowledge base.

NHIỆM VỤ: Đọc transcript → trả JSON `{type, confidence, reason}`.

CÁC TYPE:
- "kb"       — Bug/lỗi cụ thể đã được fix và verified. Có error message, root cause, và solution đã apply.
- "report"   — Hoàn thành task/công việc trong session: có work_done + outcome/kết quả cụ thể.
- "research" — Nghiên cứu, phân tích, brainstorm: có hypothesis/câu hỏi + findings/kết luận.
- "SKIP"     — Không đủ giá trị để lưu (chit-chat, Q&A lý thuyết, session chưa có kết quả).

QUY TẮC CỨNG (phải SKIP nếu vi phạm bất kỳ điều nào):
1. Dưới 5 message có nội dung technical (không tính lời chào, ack, OK).
2. Chat chỉ là Q&A lý thuyết / cách làm → không có outcome cụ thể.
3. Session chưa kết thúc: assistant vẫn đang hỏi thêm info, user chưa xác nhận kết quả.
4. Chat là chit-chat, hỏi thăm, không liên quan công việc.
5. Không có finding/fix/decision cụ thể nào được ghi nhận.

PHÂN BIỆT TYPE:
- kb vs report: kb = FIX BUG/LỖI cụ thể đã verified. Report = hoàn thành TASK (không nhất thiết phải có bug).
- report vs research: report = task đã XONG với outcome. Research = tìm hiểu / phân tích, kết luận là findings (không nhất thiết phải execute).
- kb vs research: kb = solution đã APPLY. Research = hypothesis / findings chưa apply hoặc không phải bug.

CONFIDENCE:
- > 0.7: rõ ràng.
- 0.5-0.7: khá chắc nhưng có thể nhầm. Nếu phân vân giữa kb/report/research → dùng type rõ nhất.
- < 0.5: LUÔN trả SKIP — không đoán mò.

SCHEMA OUTPUT (JSON object thuần, không markdown):
{
  "type": "kb" | "report" | "research" | "SKIP",
  "confidence": 0.0-1.0,
  "reason": "giải thích ngắn gọn 1-2 câu"
}

TRANSCRIPT:
---
{transcript}
---
"""

CLASSIFIER_PROMPT_EN = """You are a classifier for chat sessions to store in a knowledge base.

TASK: Read the transcript → return JSON `{type, confidence, reason}`.

TYPES:
- "kb"       — A specific bug/error that was fixed and verified. Has error message, root cause, and applied solution.
- "report"   — A task completed in this session: has work_done + concrete outcome.
- "research" — Research, analysis, or brainstorm: has hypothesis/question + findings/conclusion.
- "SKIP"     — Not worth saving (chit-chat, theoretical Q&A, session with no concrete outcome).

HARD RULES (must SKIP if any violated):
1. Fewer than 5 messages with technical content (greetings/ack/OK don't count).
2. Chat is only theoretical Q&A / how-to → no concrete outcome.
3. Session unfinished: assistant still asking for more info, user hasn't confirmed result.
4. Chat is chit-chat, unrelated to work.
5. No specific finding/fix/decision recorded.

DISTINGUISHING TYPES:
- kb vs report: kb = FIX a specific BUG already verified. Report = completed TASK (no bug needed).
- report vs research: report = task DONE with outcome. Research = analysis/exploration, conclusion is findings (not necessarily executed).
- kb vs research: kb = solution already APPLIED. Research = hypothesis/findings not yet applied, or not a bug.

CONFIDENCE:
- > 0.7: clear case.
- 0.5-0.7: fairly sure but could be wrong. If unsure between kb/report/research → use most evident type.
- < 0.5: ALWAYS return SKIP — do not guess.

OUTPUT SCHEMA (plain JSON object, no markdown):
{
  "type": "kb" | "report" | "research" | "SKIP",
  "confidence": 0.0-1.0,
  "reason": "brief explanation 1-2 sentences"
}

TRANSCRIPT:
---
{transcript}
---
"""


# ============================================================================
# EXTRACTOR PROMPTS
# ============================================================================

# KB extractor — adapted from onemcp-submit-kb.py _summarize() prompt,
# updated to standalone prompt format with schema + example.
KB_EXTRACTOR_PROMPT_VN = """Bạn là extractor KB — trích xuất thông tin từ chat transcript thành KB entry.

QUY TẮC:
- CHỈ trích xuất từ transcript. KHÔNG suy diễn hoặc thêm thông tin không có trong chat.
- Nghi ngờ field nào → để trống, KHÔNG hallucinate.
- Nếu transcript KHÔNG đủ để điền (thiếu bug cụ thể hoặc thiếu solution đã apply): trả {"error": "not_extractable"}.

SCHEMA (JSON object thuần, không markdown):
{
  "title": "tên service + triệu chứng cụ thể, KHÔNG kết thúc bằng ?",
  "problem": "markdown: error message + symptom + context cụ thể",
  "solution": "markdown: các bước đã apply + commands cụ thể trong ``` code block",
  "related": "markdown: links, references (optional, có thể rỗng)",
  "tags": ["tag1", "tag2"]  // max 5, snake_case, tên service + loại lỗi
}

VÍ DỤ OUTPUT HỢP LỆ:
{
  "title": "nginx 502 upstream timeout sau khi tăng tải",
  "problem": "Nginx trả 502 Bad Gateway sau ~60s khi upstream backend xử lý request nặng.\nLog: `upstream timed out (110: Connection timed out)`",
  "solution": "Tăng timeout trong nginx.conf:\n```\nproxy_read_timeout 300s;\nproxy_connect_timeout 30s;\n```\nSau đó: `nginx -t && nginx -s reload`. Verify: curl request nặng không còn 502.",
  "related": "",
  "tags": ["nginx", "http_502", "timeout", "upstream"]
}

NGÔN NGỮ: Viết title/problem/solution bằng TIẾNG VIỆT có dấu cho phần văn xuôi. Giữ nguyên EN cho: tên service/tool, error code, config key, path, command, HTTP verb, log keyword. Tags LUÔN snake_case tiếng Anh.

TRANSCRIPT:
---
{transcript}
---
"""

KB_EXTRACTOR_PROMPT_EN = """You are a KB extractor — extract information from a chat transcript into a KB entry.

RULES:
- ONLY extract from the transcript. Do NOT infer or add information not present in the chat.
- If unsure about a field → leave empty, do NOT hallucinate.
- If transcript is NOT sufficient (missing specific bug or missing applied solution): return {"error": "not_extractable"}.

SCHEMA (plain JSON object, no markdown):
{
  "title": "service name + specific symptom, must NOT end with ?",
  "problem": "markdown: error message + symptom + specific context",
  "solution": "markdown: applied steps + specific commands in ``` code blocks",
  "related": "markdown: links, references (optional, can be empty)",
  "tags": ["tag1", "tag2"]  // max 5, snake_case, service + error type
}

EXAMPLE VALID OUTPUT:
{
  "title": "nginx 502 upstream timeout under heavy load",
  "problem": "Nginx returns 502 Bad Gateway after ~60s when upstream backend processes heavy requests.\nLog: `upstream timed out (110: Connection timed out)`",
  "solution": "Increase timeout in nginx.conf:\n```\nproxy_read_timeout 300s;\nproxy_connect_timeout 30s;\n```\nThen: `nginx -t && nginx -s reload`. Verified: heavy curl requests no longer return 502.",
  "related": "",
  "tags": ["nginx", "http_502", "timeout", "upstream"]
}

TRANSCRIPT:
---
{transcript}
---
"""

REPORT_EXTRACTOR_PROMPT_VN = """Bạn là extractor Report — trích xuất thông tin từ chat transcript thành work report entry.

QUY TẮC:
- CHỈ trích xuất từ transcript. KHÔNG suy diễn hoặc thêm thông tin không có trong chat.
- Nghi ngờ field nào → để trống, KHÔNG hallucinate.
- Nếu transcript KHÔNG đủ để điền (thiếu outcome cụ thể hoặc chưa xong): trả {"error": "not_extractable"}.

SCHEMA (JSON object thuần, không markdown):
{
  "title": "tên task + kết quả ngắn gọn, KHÔNG kết thúc bằng ?",
  "context": "markdown: mục tiêu, background, lý do thực hiện task này",
  "work_done": "markdown: các bước đã làm, quyết định đã đưa ra, lệnh/config đã apply",
  "outcome": "markdown: kết quả cuối cùng — đã deliver được gì, state hiện tại sau session",
  "next_steps": "markdown: việc còn lại, follow-up, blockers (optional, có thể rỗng)",
  "tags": ["tag1", "tag2"]  // max 5, snake_case
}

VÍ DỤ OUTPUT HỢP LỆ:
{
  "title": "migrate postgres 14 → 15 trên onelog-vps",
  "context": "Postgres 14 sắp EOL tháng 11. Cần nâng lên 15 trước tháng 10 để đảm bảo security update.",
  "work_done": "1. Backup full DB với pg_dump.\n2. Cài postgres-15 song song.\n3. pg_upgrade --check → pass.\n4. pg_upgrade chạy thật, mất ~8 phút.\n5. Verify app kết nối lại bình thường.",
  "outcome": "Postgres đã chạy v15.3 trên production. App hoạt động bình thường. Backup pg14 giữ 7 ngày rồi xóa.",
  "next_steps": "Monitor log 24h. Xóa pg14 sau 7 ngày nếu không issue.",
  "tags": ["postgres", "migration", "database", "onelog_vps"]
}

NGÔN NGỮ: Viết bằng TIẾNG VIỆT có dấu cho văn xuôi. Giữ nguyên EN cho technical terms (tên service, command, config key, path). Tags LUÔN snake_case tiếng Anh.

TRANSCRIPT:
---
{transcript}
---
"""

REPORT_EXTRACTOR_PROMPT_EN = """You are a Report extractor — extract information from a chat transcript into a work report entry.

RULES:
- ONLY extract from the transcript. Do NOT infer or add information not present in the chat.
- If unsure about a field → leave empty, do NOT hallucinate.
- If transcript is NOT sufficient (missing concrete outcome or task incomplete): return {"error": "not_extractable"}.

SCHEMA (plain JSON object, no markdown):
{
  "title": "task name + brief outcome, must NOT end with ?",
  "context": "markdown: goal, background, reason for this task",
  "work_done": "markdown: steps taken, decisions made, commands/config applied",
  "outcome": "markdown: final result — what was delivered, state after session",
  "next_steps": "markdown: remaining work, follow-ups, blockers (optional, can be empty)",
  "tags": ["tag1", "tag2"]  // max 5, snake_case
}

EXAMPLE VALID OUTPUT:
{
  "title": "migrate postgres 14 → 15 on production server",
  "context": "Postgres 14 reaches EOL in November. Need to upgrade to 15 before October for security updates.",
  "work_done": "1. Full DB backup with pg_dump.\n2. Install postgres-15 in parallel.\n3. pg_upgrade --check → pass.\n4. Run actual pg_upgrade, took ~8 min.\n5. Verified app reconnects normally.",
  "outcome": "Postgres running v15.3 on production. App functioning normally. pg14 backup retained 7 days then deleted.",
  "next_steps": "Monitor logs 24h. Delete pg14 after 7 days if no issues.",
  "tags": ["postgres", "migration", "database", "production"]
}

TRANSCRIPT:
---
{transcript}
---
"""

RESEARCH_EXTRACTOR_PROMPT_VN = """Bạn là extractor Research — trích xuất thông tin từ chat transcript thành research/analysis entry.

QUY TẮC:
- CHỈ trích xuất từ transcript. KHÔNG suy diễn hoặc thêm thông tin không có trong chat.
- Nghi ngờ field nào → để trống, KHÔNG hallucinate.
- Nếu transcript KHÔNG đủ để điền (không có findings/kết luận rõ ràng): trả {"error": "not_extractable"}.

SCHEMA (JSON object thuần, không markdown):
{
  "title": "câu hỏi/chủ đề nghiên cứu ngắn gọn, KHÔNG kết thúc bằng ?",
  "question": "markdown: câu hỏi hoặc vấn đề cần giải quyết ban đầu",
  "hypothesis": "markdown: giả thuyết hoặc hướng tiếp cận ban đầu (optional)",
  "findings": "markdown: kết quả phân tích, dữ liệu tìm được, kết luận từ evidence",
  "references": "markdown: nguồn tham khảo, docs, links đã dùng (optional)",
  "conclusion": "markdown: kết luận cuối cùng, recommendation, hoặc quyết định dựa trên research"
}

VÍ DỤ OUTPUT HỢP LỆ:
{
  "title": "so sánh Qdrant vs Weaviate cho RAG use case của onelog",
  "question": "onelog cần vector DB cho RAG. Nên chọn Qdrant hay Weaviate? Tiêu chí: self-hosted, performance với 100K docs, REST API.",
  "hypothesis": "Qdrant nhẹ hơn, phù hợp cho VPS nhỏ. Weaviate có module graphQL mạnh hơn nhưng nặng.",
  "findings": "Qdrant: RAM ~300MB với 100K vectors 1536-dim, REST native, filter on payload tốt. Weaviate: RAM ~1GB minimum, GraphQL native, modules phụ thuộc. Benchmark community: Qdrant nhanh hơn 2x trên single-node với ANN search.",
  "references": "- https://qdrant.tech/benchmarks/\n- Weaviate docs: requirements",
  "conclusion": "Chọn Qdrant cho onelog. Lý do: RAM footprint thấp (phù hợp VPS 4GB), REST native (dễ integrate), community benchmark tốt. Weaviate defer đến khi cần GraphQL."
}

NGÔN NGỮ: Viết bằng TIẾNG VIỆT có dấu cho văn xuôi. Giữ nguyên EN cho technical terms (tên tool, thuật ngữ kỹ thuật, số liệu). Tags không bắt buộc cho research.

TRANSCRIPT:
---
{transcript}
---
"""

RESEARCH_EXTRACTOR_PROMPT_EN = """You are a Research extractor — extract information from a chat transcript into a research/analysis entry.

RULES:
- ONLY extract from the transcript. Do NOT infer or add information not present in the chat.
- If unsure about a field → leave empty, do NOT hallucinate.
- If transcript is NOT sufficient (no clear findings/conclusion): return {"error": "not_extractable"}.

SCHEMA (plain JSON object, no markdown):
{
  "title": "brief research topic/question, must NOT end with ?",
  "question": "markdown: initial question or problem to solve",
  "hypothesis": "markdown: initial hypothesis or approach (optional)",
  "findings": "markdown: analysis results, data found, conclusions from evidence",
  "references": "markdown: sources, docs, links used (optional)",
  "conclusion": "markdown: final conclusion, recommendation, or decision based on research"
}

EXAMPLE VALID OUTPUT:
{
  "title": "comparison Qdrant vs Weaviate for RAG use case",
  "question": "Need vector DB for RAG. Should we choose Qdrant or Weaviate? Criteria: self-hosted, performance with 100K docs, REST API.",
  "hypothesis": "Qdrant is lighter, suitable for small VPS. Weaviate has stronger GraphQL modules but heavier.",
  "findings": "Qdrant: ~300MB RAM with 100K vectors 1536-dim, native REST, good payload filtering. Weaviate: ~1GB RAM minimum, native GraphQL, module-dependent. Community benchmarks: Qdrant 2x faster on single-node ANN search.",
  "references": "- https://qdrant.tech/benchmarks/\n- Weaviate docs: requirements",
  "conclusion": "Choose Qdrant for this project. Reasons: low RAM footprint (fits 4GB VPS), native REST (easy integration), strong community benchmarks. Defer Weaviate until GraphQL is needed."
}

TRANSCRIPT:
---
{transcript}
---
"""


# ============================================================================
# Prompt registry — select by type + language
# ============================================================================

def _get_classifier_prompt(transcript: str) -> str:
    """Return classifier prompt with transcript injected, language-adapted."""
    template = CLASSIFIER_PROMPT_EN if _is_english_transcript(transcript) else CLASSIFIER_PROMPT_VN
    return template.replace("{transcript}", transcript)


def _get_extractor_prompt(artifact_type: str, transcript: str) -> str:
    """Return extractor prompt for given type with transcript injected."""
    is_en = _is_english_transcript(transcript)
    prompts = {
        "kb":       (KB_EXTRACTOR_PROMPT_VN,       KB_EXTRACTOR_PROMPT_EN),
        "report":   (REPORT_EXTRACTOR_PROMPT_VN,    REPORT_EXTRACTOR_PROMPT_EN),
        "research": (RESEARCH_EXTRACTOR_PROMPT_VN,  RESEARCH_EXTRACTOR_PROMPT_EN),
    }
    if artifact_type not in prompts:
        raise ValueError(f"Unknown artifact type: {artifact_type!r}. Must be one of: kb, report, research")
    vn_p, en_p = prompts[artifact_type]
    template = en_p if is_en else vn_p
    return template.replace("{transcript}", transcript)


# Public dict for external access (e.g., token counting, debugging)
EXTRACTOR_PROMPTS: dict[str, tuple[str, str]] = {
    "kb":       (KB_EXTRACTOR_PROMPT_VN,       KB_EXTRACTOR_PROMPT_EN),
    "report":   (REPORT_EXTRACTOR_PROMPT_VN,    REPORT_EXTRACTOR_PROMPT_EN),
    "research": (RESEARCH_EXTRACTOR_PROMPT_VN,  RESEARCH_EXTRACTOR_PROMPT_EN),
}


# ============================================================================
# GATEKEEPER_RULES
# ============================================================================

GATEKEEPER_RULES: dict[str, dict] = {
    "kb": {
        "min_body":            200,   # chars: problem + solution combined
        "min_msg":             5,     # technical messages in transcript
        "require_concrete_fix": True, # solution must have code block or command
    },
    "report": {
        "min_body":      150,   # chars: work_done + outcome combined
        "min_msg":       5,
        "require_outcome": True,  # outcome field must be non-empty
    },
    "research": {
        "min_body":       300,   # chars: findings + conclusion combined
        "min_msg":        3,     # lower bar — pure research can be shorter
        "require_finding": True, # findings field must be non-empty
    },
}

# Phrases that indicate LLM apology / uncertainty — reject if present
_APOLOGY_PATTERNS: list[re.Pattern] = [
    re.compile(r"\btôi không chắc\b", re.IGNORECASE),
    re.compile(r"\bai không (có|thể)\b", re.IGNORECASE),
    re.compile(r"\bas an ai\b", re.IGNORECASE),
    re.compile(r"\bi('m| am) an ai\b", re.IGNORECASE),
    re.compile(r"\bi don'?t have access\b", re.IGNORECASE),
    re.compile(r"\btôi không có khả năng\b", re.IGNORECASE),
    re.compile(r"\bxin lỗi, tôi không thể\b", re.IGNORECASE),
    re.compile(r"\bsorry, (i|as an ai)\b", re.IGNORECASE),
    re.compile(r"\bcannot access real.time\b", re.IGNORECASE),
    re.compile(r"\btôi không biết\b", re.IGNORECASE),
]

_TODO_PATTERN = re.compile(r"\bTODO\b|\bFIXME\b|\bTBD\b|\bXXX\b")


def _count_technical_messages(transcript: str) -> int:
    """Count messages with substantive technical content.

    Groups multiline messages into blocks (a message block starts with [role] and
    continues until the next [role] line). Filters out greetings, acks, short onfirmations.
    """
    lines = transcript.strip().split("\n")
    role_re = re.compile(r"^\[(user|assistant)\]\s*(.*)", re.IGNORECASE)

    # Build message blocks: list of full message text (role prefix stripped)
    blocks: list[str] = []
    current_parts: list[str] = []

    for line in lines:
        m = role_re.match(line)
        if m:
            # Save previous block
            if current_parts:
                blocks.append("\n".join(current_parts).strip())
                current_parts = []
            # Start new block with first line content (after [role])
            first_content = m.group(2)
            if first_content:
                current_parts.append(first_content)
        else:
            # Continuation line of current block
            if current_parts is not None:
                current_parts.append(line)

    if current_parts:
        blocks.append("\n".join(current_parts).strip())

    skip_pattern = re.compile(
        r"^(ok|okay|thanks|thank you|hi|hello|cảm ơn|được|oke|xong|done|got it|noted|alright|sure|yep|yes|no|không|có)\s*[.!]?\s*$",
        re.IGNORECASE,
    )
    technical_indicator = re.compile(
        r"(error|lỗi|config|command|```|`[^`]+`|\b(docker|nginx|postgres|python|git|curl|ssh|systemctl|service|file|path|api|http|timeout|fail|crash|fix|deploy|install|setup|migrate|update|backup|log|debug|test|run|build|check|verify|qdrant|weaviate|vector|benchmark|RAM|migrate|upgrade|pg_upgrade|pg_dump|ansible|terraform|redis|kafka|grafana)\b)",
        re.IGNORECASE,
    )

    count = 0
    for block in blocks:
        if not block or len(block) < 15:
            continue
        if skip_pattern.match(block):
            continue
        if technical_indicator.search(block):
            count += 1
    return count


def _has_concrete_fix(solution: str) -> bool:
    """Check if solution has a concrete fix artifact: code block, backtick command, numbered step."""
    concrete_patterns = [
        re.compile(r"```"),
        re.compile(r"`[a-zA-Z0-9_./-]+(\s+[^`]+)?`"),
        re.compile(r"\b(set|thêm|sửa|thay|update|edit|apply|reload|restart|deploy|run|install)\s+`?[\w./-]+`?", re.IGNORECASE),
        re.compile(r"^\s*\d+[.)]\s+.{20,}", re.MULTILINE),
    ]
    return any(p.search(solution) for p in concrete_patterns)


def gatekeeper_check(artifact_type: str, draft: dict[str, Any], transcript: str) -> tuple[bool, str]:
    """Validate draft against gatekeeper rules for given artifact type.

    Args:
        artifact_type: "kb" | "report" | "research"
        draft: extracted JSON dict from LLM extractor
        transcript: original (redacted) chat transcript

    Returns:
        (ok: bool, reason: str) — reason is human-readable rejection explanation.
    """
    if artifact_type not in GATEKEEPER_RULES:
        return False, f"Unknown type: {artifact_type!r}"

    rules = GATEKEEPER_RULES[artifact_type]

    # 1 — LLM extraction error signal
    if draft.get("error") == "not_extractable":
        return False, "LLM báo không extract được từ transcript này"

    # 2 — Apology phrases (LLM hallucination indicator)
    all_text = " ".join(str(v) for v in draft.values() if isinstance(v, str))
    for pat in _APOLOGY_PATTERNS:
        if pat.search(all_text):
            return False, f"Draft chứa LLM apology phrase — không đáng tin cậy"

    # 3 — TODO markers (unresolved placeholders)
    if _TODO_PATTERN.search(all_text):
        return False, "Draft chứa TODO/FIXME/TBD marker — chưa hoàn chỉnh"

    # 4 — Technical message count
    tech_count = _count_technical_messages(transcript)
    min_msg = rules.get("min_msg", 5)
    if tech_count < min_msg:
        return False, f"Transcript chỉ có {tech_count} message technical (tối thiểu {min_msg})"

    # 5 — Type-specific checks
    if artifact_type == "kb":
        problem = str(draft.get("problem", "")).strip()
        solution = str(draft.get("solution", "")).strip()
        title = str(draft.get("title", "")).strip()

        if len(title) < 15:
            return False, f"title quá ngắn ({len(title)} < 15 ký tự)"
        if title.endswith("?"):
            return False, "title là câu hỏi — không phải KB fix entry"

        body_len = len(problem) + len(solution)
        if body_len < rules["min_body"]:
            return False, f"problem + solution quá ngắn ({body_len} < {rules['min_body']} ký tự)"

        if len(problem) < 40:
            return False, f"problem quá ngắn ({len(problem)} < 40 ký tự)"
        if len(solution) < 40:
            return False, f"solution quá ngắn ({len(solution)} < 40 ký tự)"

        if rules.get("require_concrete_fix") and not _has_concrete_fix(solution):
            return False, "solution thiếu concrete fix (code block / command / numbered step)"

    elif artifact_type == "report":
        work_done = str(draft.get("work_done", "")).strip()
        outcome = str(draft.get("outcome", "")).strip()
        title = str(draft.get("title", "")).strip()

        if len(title) < 10:
            return False, f"title quá ngắn ({len(title)} < 10 ký tự)"

        body_len = len(work_done) + len(outcome)
        if body_len < rules["min_body"]:
            return False, f"work_done + outcome quá ngắn ({body_len} < {rules['min_body']} ký tự)"

        if rules.get("require_outcome") and len(outcome) < 30:
            return False, f"outcome trống hoặc quá ngắn ({len(outcome)} < 30 ký tự) — chưa rõ kết quả"

    elif artifact_type == "research":
        findings = str(draft.get("findings", "")).strip()
        conclusion = str(draft.get("conclusion", "")).strip()
        title = str(draft.get("title", "")).strip()

        if len(title) < 10:
            return False, f"title quá ngắn ({len(title)} < 10 ký tự)"

        body_len = len(findings) + len(conclusion)
        if body_len < rules["min_body"]:
            return False, f"findings + conclusion quá ngắn ({body_len} < {rules['min_body']} ký tự)"

        if rules.get("require_finding") and len(findings) < 80:
            return False, f"findings quá ngắn hoặc trống ({len(findings)} < 80 ký tự)"

    return True, "ok"


# ============================================================================
# Public API functions
# ============================================================================

def classify(transcript: str, llm_call: Callable[[str], str]) -> dict[str, Any]:
    """Classify transcript into kb/report/research/SKIP.

    Args:
        transcript: redacted chat transcript string
        llm_call: callable(prompt: str) -> str (JSON string response)

    Returns:
        dict with keys: type, confidence, reason
        On parse error: {"type": "SKIP", "confidence": 0.0, "reason": "parse error: <msg>"}
    """
    prompt = _get_classifier_prompt(transcript)
    try:
        raw = llm_call(prompt)
        # Strip markdown code fences if LLM wraps JSON
        raw = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.MULTILINE)
        raw = re.sub(r"```\s*$", "", raw.strip(), flags=re.MULTILINE)
        result = json.loads(raw.strip())
    except (json.JSONDecodeError, Exception) as e:
        return {"type": "SKIP", "confidence": 0.0, "reason": f"parse error: {e}"}

    artifact_type = str(result.get("type", "SKIP"))
    confidence = float(result.get("confidence", 0.0))
    reason = str(result.get("reason", ""))

    # Enforce confidence threshold: < 0.5 always SKIP
    if confidence < 0.5 and artifact_type != "SKIP":
        artifact_type = "SKIP"
        reason = f"confidence {confidence:.2f} < 0.5 threshold → auto-SKIP. Original: {reason}"

    return {"type": artifact_type, "confidence": confidence, "reason": reason}


def extract(
    artifact_type: str,
    transcript: str,
    template_schema: dict[str, Any],
    llm_call: Callable[[str], str],
) -> dict[str, Any]:
    """Extract structured fields from transcript for given artifact type.

    Args:
        artifact_type: "kb" | "report" | "research"
        transcript: redacted chat transcript string
        template_schema: schema dict from OneMCP template (used for future validation extension)
        llm_call: callable(prompt: str) -> str (JSON string response)

    Returns:
        dict with extracted fields, or {"error": "not_extractable"} if LLM signals failure.
        On parse error: {"error": "parse_error", "detail": str(e)}
    """
    prompt = _get_extractor_prompt(artifact_type, transcript)
    try:
        raw = llm_call(prompt)
        raw = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.MULTILINE)
        raw = re.sub(r"```\s*$", "", raw.strip(), flags=re.MULTILINE)
        result = json.loads(raw.strip())
    except (json.JSONDecodeError, Exception) as e:
        return {"error": "parse_error", "detail": str(e)}

    return result


def get_prompt_token_estimate(prompt_text: str) -> int:
    """Rough token count estimate: len(text) / 4. For budget checking only."""
    return len(prompt_text) // 4
