"""
title: End & Save
author: onelog
version: 0.1.0
description: |
  Action button 🏁 — cuối session, tự động classify + extract + preview + submit artifact vào OneMCP.
  3 loại artifact được hỗ trợ: KB entry (bug fix), Report (task hoàn thành), Research (phân tích).

  CÁCH DÙNG:
    Click 🏁 ở cuối session khi đã hoàn thành công việc.
    Action sẽ:
    1. Redact PII (hard block secrets, soft replace IP/email)
    2. Classify session → kb / report / research / SKIP
    3. Fetch schema template từ OneMCP
    4. Extract structured fields qua LLM
    5. Gatekeeper validation (no-LLM rule checks)
    6. Preview + confirm UI
    7. Submit vào OneMCP → citation link

  Nếu SKIP: toast warning + audit log, không submit.
  Nếu REJECT: toast error + audit log, không submit.
  Nếu user Cancel: audit log wrapup.cancelled.

requirements: httpx

═══════════════════════════════════════════════════════════════════════════════
INTERNAL FLOW
═══════════════════════════════════════════════════════════════════════════════

  1. Get last N=40 messages
  2. Skip if < 5 messages total (too short)
  3. hard block + soft redact → redacted_transcript
  4. classify(redacted_transcript) via CLASSIFIER_MODEL
     └─ SKIP / low confidence → toast + audit wrapup.skipped_classifier → exit
  5. MCP get_artifact_template(type) → template schema
  6. extract(type, redacted_transcript, template) via EXTRACTOR_MODEL
     └─ parse error: retry once → if still fail, toast + exit
  7. gatekeeper_check(type, draft, redacted_transcript)
     └─ REJECT → toast + audit wrapup.rejected_gatekeeper → exit
  8. Preview: emit inline message with type badge + editable JSON/markdown draft
     [Confirm submit] [Cancel] buttons via __event_call__
  9. On confirm: submit_artifact via MCP, audit wrapup.submitted, toast + citation link
     On cancel: audit wrapup.cancelled, toast info

Audit events: wrapup.attempted, wrapup.skipped_classifier, wrapup.rejected_gatekeeper,
              wrapup.submitted, wrapup.cancelled

Plan 260730-1043 Phase 3.
"""

import json
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx
from pydantic import BaseModel, Field


# ============================================================================
# INLINED redact.py — OpenWebUI Action single-file constraint.
# Source of truth: infra/openwebui/actions/redact.py (sync manually on update).
# ============================================================================


class RedactBlocked(Exception):
    """Raised khi transcript chứa secret pattern KHÔNG cho phép submit."""

    def __init__(self, pattern_name: str, sample: str = ""):
        self.pattern_name = pattern_name
        self.sample = sample[:40]
        super().__init__(f"Blocked by {pattern_name} pattern (sample: {self.sample!r})")


HARD_BLOCK_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("pem_private_key", re.compile(r"-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----")),
    ("ssh_rsa_key", re.compile(r"ssh-rsa AAAA[A-Za-z0-9+/=]{200,}")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("gcp_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("openai_key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    (
        "jwt_token",
        re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b"),
    ),
]

SOFT_REDACT_RULES: list[tuple[str, re.Pattern, str]] = [
    (
        "private_ip",
        re.compile(
            r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b"
        ),
        "<REDACTED_PRIVATE_IP>",
    ),
    ("public_ip", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "<REDACTED_IP>"),
    (
        "external_email",
        re.compile(r"\b[a-zA-Z0-9._%+-]+@(?!inet\.vn\b)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b"),
        "<REDACTED_EMAIL>",
    ),
    (
        "sensitive_path",
        re.compile(r"(?:/[\w.-]+)*/(?:\.env(?:\.\w+)?|id_rsa(?:\.pub)?|credentials\.json)\b"),
        "<REDACTED_PATH>",
    ),
]


@dataclass
class RedactResult:
    text: str
    hits: dict[str, int]


def _check_hard_block(text: str) -> None:
    for name, pat in HARD_BLOCK_PATTERNS:
        m = pat.search(text)
        if m:
            raise RedactBlocked(name, m.group(0))


def _soft_redact(text: str) -> RedactResult:
    hits: dict[str, int] = {}
    out = text
    for name, pat, placeholder in SOFT_REDACT_RULES:
        new_out, n = pat.subn(placeholder, out)
        if n > 0:
            hits[name] = n
            out = new_out
    return RedactResult(text=out, hits=hits)


# ============================================================================
# INLINED wrapup-prompts.py — OpenWebUI Action single-file constraint.
# Source of truth: infra/openwebui/actions/wrapup-prompts.py (sync manually on update).
# ============================================================================


def _is_english_transcript(transcript: str) -> bool:
    """Heuristic: if >55% chars are ASCII alpha → treat as EN transcript."""
    if not transcript:
        return False
    alpha_chars = [c for c in transcript if c.isalpha()]
    if not alpha_chars:
        return False
    ascii_alpha = sum(1 for c in alpha_chars if ord(c) < 128)
    return (ascii_alpha / len(alpha_chars)) > 0.55


_CLASSIFIER_PROMPT_VN = """Bạn là classifier phân loại chat session để lưu vào knowledge base.

NHIỆM VỤ: Đọc transcript → trả JSON `{type, confidence, reason}`.

CÁC TYPE:
- "kb"       — Bug/lỗi cụ thể đã fix và verified. Có error, root cause, solution.
- "report"   — Hoàn thành task/công việc: có steps + outcome/kết quả cụ thể.
- "research" — Nghiên cứu, phân tích, thiết kế, brainstorm: có câu hỏi/mục tiêu + findings/deliverable
               (VD: query design, config draft, so sánh options, phân tích log pattern, đề xuất giải pháp).
- "SKIP"     — Thật sự không đáng lưu (chit-chat, câu hỏi 1 dòng chưa có trả lời, session hoàn toàn không có deliverable).

DELIVERABLE HỢP LỆ (nếu có → KHÔNG được SKIP):
- Code block ```...``` (query, config, script)
- Bảng so sánh / analysis
- Đề xuất giải pháp cụ thể có step
- Fix/decision đã ghi nhận
- Structured breakdown (numbered list of options/steps)

QUY TẮC CỨNG (SKIP nếu VI PHẠM):
1. Dưới 3 message có nội dung technical thật sự (không tính chào hỏi).
2. Assistant không trả lời hoặc trả lời rỗng.
3. Chat hoàn toàn là chit-chat, off-topic.
4. Không có bất kỳ deliverable nào (code, config, phân tích, đề xuất, quyết định).

KHÔNG SKIP CHỈ VÌ:
- Session là Q&A → nếu assistant trả bằng deliverable cụ thể (query, config, list of steps) → là "research" hoặc "kb".
- User chưa "apply" solution → nếu assistant đã đưa ra deliverable → vẫn là "research" (chưa apply) hoặc "kb" (nếu là bug fix).
- Có follow-up questions → miễn có deliverable chính thì OK.

PHÂN BIỆT TYPE:
- kb vs report: kb = FIX BUG cụ thể. Report = task hoàn thành (không cần bug).
- report vs research: report = đã XONG có outcome. Research = đưa ra deliverable/analysis (chưa nhất thiết apply).
- kb vs research: kb = solution APPLY và verified. Research = deliverable/query/analysis (chưa apply hoặc không phải bug).
- Nếu assistant trả bằng 1 query/config/script cụ thể mà user chưa xác nhận đã apply → thường là "research".

CONFIDENCE:
- > 0.7: rõ ràng.
- 0.5-0.7: khá chắc. Nếu phân vân → dùng type rõ nhất.
- < 0.5: LUÔN trả SKIP — không đoán mò.

SCHEMA OUTPUT (JSON object thuần, không markdown):
{"type": "kb" | "report" | "research" | "SKIP", "confidence": 0.0-1.0, "reason": "1-2 câu"}

TRANSCRIPT:
---
{transcript}
---
"""

_CLASSIFIER_PROMPT_EN = """You are a classifier for chat sessions to store in a knowledge base.

TASK: Read the transcript → return JSON `{type, confidence, reason}`.

TYPES:
- "kb"       — Specific bug fixed and verified. Has error, root cause, applied solution.
- "report"   — Task completed: steps + concrete outcome.
- "research" — Research, analysis, design, brainstorm: has question/goal + findings/deliverable
               (e.g. query design, config draft, options comparison, log pattern analysis, proposed solution).
- "SKIP"     — Truly not worth saving (chit-chat, one-line question without answer, no deliverable at all).

VALID DELIVERABLES (if present → do NOT SKIP):
- Code blocks ```...``` (query, config, script)
- Comparison table / analysis
- Concrete proposed solution with steps
- Recorded fix/decision
- Structured breakdown (numbered options/steps)

HARD RULES (SKIP if VIOLATED):
1. Fewer than 3 messages with genuine technical content.
2. Assistant never replies or replies empty.
3. Chat is purely chit-chat, off-topic.
4. No deliverable of any kind (code, config, analysis, proposal, decision).

DO NOT SKIP JUST BECAUSE:
- Session is Q&A → if assistant answered with concrete deliverable → it's "research" or "kb".
- User hasn't "applied" the solution → if assistant provided a deliverable → still "research".
- Follow-up questions exist → as long as a main deliverable is there, OK.

CONFIDENCE:
- > 0.7: clear case.
- 0.5-0.7: fairly sure. If unsure → use most evident type.
- < 0.5: ALWAYS return SKIP.

OUTPUT SCHEMA (plain JSON, no markdown):
{"type": "kb" | "report" | "research" | "SKIP", "confidence": 0.0-1.0, "reason": "1-2 sentences"}

TRANSCRIPT:
---
{transcript}
---
"""

_KB_EXTRACTOR_PROMPT_VN = """Bạn là extractor KB — trích xuất TOÀN BỘ nội dung bug fix từ transcript.

QUY TẮC:
1. CHỈ trích xuất từ transcript. KHÔNG suy diễn.
2. **TỔNG HỢP TOÀN BỘ**: nếu session có nhiều lỗi/fix, gom hết vào 1 KB (dùng section rõ ràng cho từng lỗi).
3. Giữ nguyên chi tiết: error message, service names, commands, config keys.
4. Thiếu dữ liệu concrete → trả {"error": "not_extractable"}.

SCHEMA (JSON thuần):
{
  "title": "service + triệu chứng cụ thể, KHÔNG kết thúc bằng ?",
  "problem": "markdown DÀI: mô tả TẤT CẢ error observed, context, khi nào xảy ra. Dùng bullet/section nếu nhiều lỗi.",
  "solution": "markdown CHI TIẾT: TẤT CẢ steps đã apply, commands trong ``` block. Bao gồm verify steps.",
  "related": "markdown (optional): links, related issues",
  "tags": ["tag1"] /* max 5, snake_case */
}

NGÔN NGỮ OUTPUT:
- Viết title/problem/solution bằng TIẾNG VIỆT có dấu cho phần văn xuôi mô tả (triệu chứng, ngữ cảnh, giải thích, bước làm).
- GIỮ NGUYÊN tiếng Anh cho technical terms không có nghĩa VN tương đương: tên service/tool (nginx, crowdsec, docker, systemd...), error code (502, OOM, SIGKILL), config key (proxy_read_timeout, api_key), path (/etc/..., /opt/...), command, exit code, HTTP verb, log keyword.
- KHÔNG dịch máy móc kiểu "thời gian chờ đọc proxy" hay "cửa sổ trượt".
- Tags LUÔN snake_case tiếng Anh (VD: bouncer_disconnected, http_502, oom_kill).

TRANSCRIPT:
---
{transcript}
---
"""

_KB_EXTRACTOR_PROMPT_EN = """You are a KB extractor — extract information from transcript into a KB entry.

RULES: ONLY extract from transcript. Do NOT infer. If insufficient → return {"error": "not_extractable"}.

SCHEMA (plain JSON):
{"title": "service + specific symptom, must NOT end with ?", "problem": "markdown: error message + context", "solution": "markdown: applied steps + commands in ``` blocks", "related": "markdown (optional)", "tags": ["tag1"] /* max 5, snake_case */}

TRANSCRIPT:
---
{transcript}
---
"""

_REPORT_EXTRACTOR_PROMPT_VN = """Bạn là extractor Report — tổng hợp TOÀN BỘ công việc trong session thành work report.

QUY TẮC:
1. CHỈ trích xuất từ transcript. KHÔNG suy diễn.
2. **TỔNG HỢP TOÀN BỘ**: liệt kê TẤT CẢ steps đã làm, decisions đã chốt, không lược bỏ.
3. Giữ nguyên chi tiết: commands, file paths, config changes, metrics.
4. Thiếu outcome concrete → trả {"error": "not_extractable"}.

SCHEMA (JSON thuần):
{
  "title": "task + kết quả ngắn gọn, KHÔNG kết thúc bằng ?",
  "context": "markdown: mục tiêu + background + tại sao làm",
  "work_done": "markdown DÀI VÀ CHI TIẾT: TẤT CẢ steps + decisions + commands đã apply, numbered list nếu nhiều bước",
  "outcome": "markdown: kết quả cuối cụ thể, metrics/state/deliverable",
  "next_steps": "markdown (optional): follow-up items",
  "tags": ["tag1"] /* max 5, snake_case */
}

NGÔN NGỮ OUTPUT:
- Viết title/context/work_done/outcome/next_steps bằng TIẾNG VIỆT có dấu cho phần văn xuôi (mục tiêu, background, quyết định, kết quả).
- GIỮ NGUYÊN tiếng Anh cho technical terms: tên service/tool (nginx, postgres, k8s...), command, path, config key, metric, HTTP verb, error code.
- KHÔNG dịch máy móc technical terms (VD giữ "restart container", không dịch "khởi động lại container").
- Tags LUÔN snake_case tiếng Anh (VD: migration_done, rollout_prod, backup_verified).

TRANSCRIPT:
---
{transcript}
---
"""

_REPORT_EXTRACTOR_PROMPT_EN = """You are a Report extractor — extract information from transcript into a work report.

RULES: ONLY extract from transcript. Do NOT infer. If insufficient → return {"error": "not_extractable"}.

SCHEMA (plain JSON):
{"title": "task + brief outcome, must NOT end with ?", "context": "markdown: goal + background", "work_done": "markdown: steps + decisions + commands applied", "outcome": "markdown: final result, what was delivered", "next_steps": "markdown (optional)", "tags": ["tag1"] /* max 5, snake_case */}

TRANSCRIPT:
---
{transcript}
---
"""

_RESEARCH_EXTRACTOR_PROMPT_VN = """Bạn là extractor Research — trích xuất TOÀN BỘ nội dung research từ transcript.

QUY TẮC QUAN TRỌNG:
1. CHỈ trích xuất từ transcript. KHÔNG suy diễn ngoài.
2. **TỔNG HỢP TOÀN BỘ session** — nếu session có nhiều câu hỏi/chủ đề, gom lại thành 1 research đầy đủ.
3. **KHÔNG chỉ pick câu hỏi cuối** — phải cover tất cả topics user hỏi + tất cả findings assistant đưa ra.
4. **Giữ nguyên chi tiết technical**: service names, error codes, commands, queries, config keys, threshold numbers.
5. Thiếu findings rõ → trả {"error": "not_extractable"}.

SCHEMA (JSON thuần):
{
  "title": "chủ đề tổng thể của session, ngắn gọn, KHÔNG kết thúc bằng ?",
  "question": "markdown: gom TẤT CẢ câu hỏi user hỏi thành 1 khối, dùng bullet points nếu >1 câu",
  "hypothesis": "markdown (optional): giả thuyết ban đầu nếu có",
  "findings": "markdown DÀI VÀ CHI TIẾT: liệt kê TẤT CẢ phát hiện, phân tích, error types, root cause, kèm code block ``` cho commands/queries. Dùng H3 (### service_name) hoặc numbered list cho từng finding riêng biệt.",
  "references": "markdown (optional): logs/paths/docs mentioned",
  "conclusion": "markdown: tổng kết + recommendation cuối, gom tất cả action items"
}

NGÔN NGỮ OUTPUT:
- Viết title/question/hypothesis/findings/conclusion bằng TIẾNG VIỆT có dấu cho phần văn xuôi (câu hỏi nghiên cứu, giả thuyết, phân tích, kết luận, recommendation).
- GIỮ NGUYÊN tiếng Anh cho technical terms: tên service/tool (crowdsec, ssmtp, rsyslog, systemd, victorialogs...), error code (OOM, SIGKILL, 502), config key (proxy_read_timeout, MaxSessions), path (/opt/, /var/log/), command, query, log keyword, metric name.
- KHÔNG dịch máy móc technical terms (giữ "session systemd đầy", không dịch "phiên systemd đầy"; giữ "disk usage > 80%", không đổi thành "sử dụng đĩa vượt 80 phần trăm").
- Trong code block ``` giữ NGUYÊN 100% (không thêm ký tự VN vào commands/queries).

CẤM: rút gọn findings <200 ký tự khi transcript có nội dung technical dài. Nếu transcript có 5+ topics/errors, findings phải cover đủ.

TRANSCRIPT:
---
{transcript}
---
"""

_RESEARCH_EXTRACTOR_PROMPT_EN = """You are a Research extractor — extract the ENTIRE research content from transcript.

CRITICAL RULES:
1. ONLY extract from transcript. Do NOT infer beyond.
2. **SYNTHESIZE THE ENTIRE session** — if multiple questions/topics, aggregate into 1 comprehensive research.
3. **Do NOT pick only the last question** — cover ALL topics user asked + ALL findings assistant provided.
4. **Preserve technical detail**: service names, error codes, commands, queries, config keys, thresholds.
5. If insufficient findings → return {"error": "not_extractable"}.

SCHEMA (plain JSON):
{
  "title": "overall session topic, brief, must NOT end with ?",
  "question": "markdown: gather ALL user questions, use bullet points if >1",
  "hypothesis": "markdown (optional): initial hypothesis if any",
  "findings": "markdown LONG AND DETAILED: list ALL findings/analysis/error types/root causes with ``` blocks for commands/queries. Use H3 (### service_name) or numbered list per finding.",
  "references": "markdown (optional): logs/paths/docs mentioned",
  "conclusion": "markdown: final wrap-up + all action items"
}

FORBIDDEN: findings <200 chars when transcript has long technical content. If transcript has 5+ topics/errors, findings must cover all.

TRANSCRIPT:
---
{transcript}
---
"""

_EXTRACTOR_PROMPTS: dict[str, tuple[str, str]] = {
    "kb":       (_KB_EXTRACTOR_PROMPT_VN,       _KB_EXTRACTOR_PROMPT_EN),
    "report":   (_REPORT_EXTRACTOR_PROMPT_VN,    _REPORT_EXTRACTOR_PROMPT_EN),
    "research": (_RESEARCH_EXTRACTOR_PROMPT_VN,  _RESEARCH_EXTRACTOR_PROMPT_EN),
}

_APOLOGY_PATTERNS: list[re.Pattern] = [
    re.compile(r"\btôi không chắc\b", re.IGNORECASE),
    re.compile(r"\bas an ai\b", re.IGNORECASE),
    re.compile(r"\bi('m| am) an ai\b", re.IGNORECASE),
    re.compile(r"\bi don'?t have access\b", re.IGNORECASE),
    re.compile(r"\bsorry, (i|as an ai)\b", re.IGNORECASE),
    re.compile(r"\btôi không biết\b", re.IGNORECASE),
]

_TODO_PATTERN = re.compile(r"\bTODO\b|\bFIXME\b|\bTBD\b|\bXXX\b")

_GATEKEEPER_RULES: dict[str, dict] = {
    "kb": {
        "min_body": 200,
        "min_msg": 5,
        "require_concrete_fix": True,
    },
    "report": {
        "min_body": 150,
        "min_msg": 5,
        "require_outcome": True,
    },
    "research": {
        "min_body": 300,
        "min_msg": 3,
        "require_finding": True,
    },
}


def _count_technical_messages(transcript: str) -> int:
    lines = transcript.strip().split("\n")
    role_re = re.compile(r"^\[(user|assistant)\]\s*(.*)", re.IGNORECASE)
    blocks: list[str] = []
    current_parts: list[str] = []
    for line in lines:
        m = role_re.match(line)
        if m:
            if current_parts:
                blocks.append("\n".join(current_parts).strip())
                current_parts = []
            first_content = m.group(2)
            if first_content:
                current_parts.append(first_content)
        else:
            current_parts.append(line)
    if current_parts:
        blocks.append("\n".join(current_parts).strip())

    skip_pattern = re.compile(
        r"^(ok|okay|thanks|thank you|hi|hello|cảm ơn|được|oke|xong|done|got it|noted|alright|sure|yep|yes|no|không|có)\s*[.!]?\s*$",
        re.IGNORECASE,
    )
    technical_indicator = re.compile(
        r"(error|lỗi|config|command|```|`[^`]+`|\b(docker|nginx|postgres|python|git|curl|ssh|systemctl|api|http|timeout|fail|crash|fix|deploy|install|setup|migrate|update|backup|log|debug|test|run|build|check|verify|qdrant|vector|redis|kafka|ansible|terraform)\b)",
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
    concrete_patterns = [
        re.compile(r"```"),
        re.compile(r"`[a-zA-Z0-9_./-]+(\s+[^`]+)?`"),
        re.compile(r"\b(set|thêm|sửa|thay|update|edit|apply|reload|restart|deploy|run|install)\s+`?[\w./-]+`?", re.IGNORECASE),
        re.compile(r"^\s*\d+[.)]\s+.{20,}", re.MULTILINE),
    ]
    return any(p.search(solution) for p in concrete_patterns)


def _wrapup_classify(transcript: str, llm_call: Callable[[str], str]) -> dict[str, Any]:
    """Classify transcript → {type, confidence, reason}."""
    template = _CLASSIFIER_PROMPT_EN if _is_english_transcript(transcript) else _CLASSIFIER_PROMPT_VN
    prompt = template.replace("{transcript}", transcript)
    try:
        raw = llm_call(prompt)
        raw = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.MULTILINE)
        raw = re.sub(r"```\s*$", "", raw.strip(), flags=re.MULTILINE)
        result = json.loads(raw.strip())
    except Exception as e:
        return {"type": "SKIP", "confidence": 0.0, "reason": f"parse error: {e}"}
    artifact_type = str(result.get("type", "SKIP"))
    confidence = float(result.get("confidence", 0.0))
    reason = str(result.get("reason", ""))
    if confidence < 0.5 and artifact_type != "SKIP":
        artifact_type = "SKIP"
        reason = f"confidence {confidence:.2f} < 0.5 → auto-SKIP. Original: {reason}"
    return {"type": artifact_type, "confidence": confidence, "reason": reason}


def _wrapup_extract(
    artifact_type: str,
    transcript: str,
    llm_call: Callable[[str], str],
) -> dict[str, Any]:
    """Extract structured fields from transcript for given type."""
    if artifact_type not in _EXTRACTOR_PROMPTS:
        return {"error": "parse_error", "detail": f"Unknown type: {artifact_type!r}"}
    vn_p, en_p = _EXTRACTOR_PROMPTS[artifact_type]
    template = en_p if _is_english_transcript(transcript) else vn_p
    prompt = template.replace("{transcript}", transcript)
    try:
        raw = llm_call(prompt)
        raw = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.MULTILINE)
        raw = re.sub(r"```\s*$", "", raw.strip(), flags=re.MULTILINE)
        result = json.loads(raw.strip())
    except Exception as e:
        return {"error": "parse_error", "detail": str(e)}
    return result


def _wrapup_gatekeeper(
    artifact_type: str, draft: dict[str, Any], transcript: str
) -> tuple[bool, str]:
    """Validate draft against gatekeeper rules. Returns (ok, reason)."""
    if artifact_type not in _GATEKEEPER_RULES:
        return False, f"Unknown type: {artifact_type!r}"
    rules = _GATEKEEPER_RULES[artifact_type]

    if draft.get("error") in ("not_extractable", "parse_error"):
        detail = draft.get("detail", "")
        return False, f"LLM extraction failed: {draft.get('error')} {detail}".strip()

    all_text = " ".join(str(v) for v in draft.values() if isinstance(v, str))
    for pat in _APOLOGY_PATTERNS:
        if pat.search(all_text):
            return False, "Draft chứa LLM apology phrase — không đáng tin cậy"
    if _TODO_PATTERN.search(all_text):
        return False, "Draft chứa TODO/FIXME/TBD marker — chưa hoàn chỉnh"

    tech_count = _count_technical_messages(transcript)
    min_msg = rules.get("min_msg", 5)
    if tech_count < min_msg:
        return False, f"Transcript chỉ có {tech_count} technical message (tối thiểu {min_msg})"

    if artifact_type == "kb":
        title = str(draft.get("title", "")).strip()
        problem = str(draft.get("problem", "")).strip()
        solution = str(draft.get("solution", "")).strip()
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
        title = str(draft.get("title", "")).strip()
        work_done = str(draft.get("work_done", "")).strip()
        outcome = str(draft.get("outcome", "")).strip()
        if len(title) < 10:
            return False, f"title quá ngắn ({len(title)} < 10 ký tự)"
        body_len = len(work_done) + len(outcome)
        if body_len < rules["min_body"]:
            return False, f"work_done + outcome quá ngắn ({body_len} < {rules['min_body']} ký tự)"
        if rules.get("require_outcome") and len(outcome) < 30:
            return False, f"outcome trống hoặc quá ngắn ({len(outcome)} < 30 ký tự)"

    elif artifact_type == "research":
        title = str(draft.get("title", "")).strip()
        findings = str(draft.get("findings", "")).strip()
        conclusion = str(draft.get("conclusion", "")).strip()
        if len(title) < 10:
            return False, f"title quá ngắn ({len(title)} < 10 ký tự)"
        body_len = len(findings) + len(conclusion)
        if body_len < rules["min_body"]:
            return False, f"findings + conclusion quá ngắn ({body_len} < {rules['min_body']} ký tự)"
        if rules.get("require_finding") and len(findings) < 80:
            return False, f"findings quá ngắn ({len(findings)} < 80 ký tự)"

    return True, "ok"


# ============================================================================
# Action class
# ============================================================================

_TYPE_EMOJI: dict[str, str] = {
    "kb": "📚",
    "report": "📋",
    "research": "🔬",
}

_TYPE_LABEL: dict[str, str] = {
    "kb": "KB Entry (Bug Fix)",
    "report": "Work Report",
    "research": "Research Note",
}


class Action:
    class Valves(BaseModel):
        ONEMCP_URL: str = Field(default="https://10.200.0.44")
        BOT_USER: str = Field(default="openwebui-bot")
        ONEMCP_CA_PATH: str = Field(
            default="/opt/onemcp-ca.crt",
            description="Path tới OneMCP self-signed cert. Rỗng = disable verify.",
        )
        TIMEOUT_SEC: float = Field(default=30.0)
        CLASSIFIER_MODEL: str = Field(
            default="deepseek",
            description="LiteLLM model dùng để classify session (fast + cheap). Phải khớp model_name trong litellm config.yaml.",
        )
        EXTRACTOR_MODEL: str = Field(
            default="deepseek",
            description="LiteLLM model dùng để extract structured fields. Phải khớp model_name trong litellm config.yaml.",
        )
        LITELLM_BASE_URL: str = Field(default="http://litellm-proxy:4000/v1")
        LITELLM_API_KEY: str = Field(default="", description="OpenWebUI virtual key hoặc LiteLLM master key.")
        OPENWEBUI_URL: str = Field(
            default="http://localhost:8080",
            description="OpenWebUI internal URL để fetch chat history khi body.messages assistant content rỗng.",
        )
        OPENWEBUI_API_KEY: str = Field(
            default="",
            description="OpenWebUI API key. Tạo tại Settings → Account → API Keys. Cần thiết để fetch chat content đầy đủ.",
        )
        MAX_TRANSCRIPT_MSG: int = Field(default=40, description="Max messages gửi vào LLM. Cap token cost.")
        CLASSIFIER_CONFIDENCE_THRESHOLD: float = Field(
            default=0.5,
            description="Confidence cutoff để SKIP. Default 0.5 khớp internal check của classifier. Tăng lên nếu muốn strict hơn.",
        )

    def __init__(self):
        self.valves = self.Valves()
        self.icon_url = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><text y='20' font-size='20'>🏁</text></svg>"
        self._user_cache: dict[str, str] = {}

    # ------------------------------------------------------------------ helpers

    async def _resolve_username(self, body: dict[str, Any]) -> tuple[str, str]:
        """Resolve OneMCP username. Returns (username, 'user'|'bot')."""
        email: str = ""
        try:
            user_ctx = body.get("user") or {}
            email = str(user_ctx.get("email") or "").strip().lower()
        except Exception:
            pass

        if not email or not email.endswith("@inet.vn"):
            return self.valves.BOT_USER, "bot"

        if email in self._user_cache:
            return self._user_cache[email], "user"

        try:
            ensure_url = f"{self.valves.ONEMCP_URL.rstrip('/')}/api/users/ensure"
            verify_arg: bool | str = self.valves.ONEMCP_CA_PATH or False
            async with httpx.AsyncClient(verify=verify_arg, timeout=self.valves.TIMEOUT_SEC) as c:
                r = await c.post(ensure_url, json={"email": email})
                r.raise_for_status()
                data = r.json()
            username: str = str(data.get("username") or "").strip()
            if not username:
                raise ValueError("ensure returned empty username")
            self._user_cache[email] = username
            return username, "user"
        except Exception as exc:
            print(f"[onemcp-wrapup] _resolve_username failed for {email}: {exc}", flush=True)
            return self.valves.BOT_USER, "bot"

    async def _rpc(self, method: str, params: dict[str, Any], username: str) -> dict[str, Any]:
        """JSON-RPC 2.0 call to OneMCP /api/mcp."""
        url = f"{self.valves.ONEMCP_URL.rstrip('/')}/api/mcp"
        headers = {"X-Onemcp-User": username, "Content-Type": "application/json"}
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        verify_arg: bool | str = self.valves.ONEMCP_CA_PATH or False
        async with httpx.AsyncClient(verify=verify_arg, timeout=self.valves.TIMEOUT_SEC) as c:
            r = await c.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
        if "error" in data:
            raise RuntimeError(f"OneMCP RPC error: {data['error']}")
        return data.get("result", {})

    async def _audit(self, event: str, username: str, payload: dict[str, Any]) -> None:
        """Emit audit event to OneMCP. Non-fatal: log error but don't raise."""
        try:
            await self._rpc(
                "tools/call",
                {
                    "name": "emit_audit_event",
                    "arguments": {
                        "event": event,
                        "actor": username,
                        "data": payload,
                    },
                },
                username,
            )
        except Exception as exc:
            # Audit failure must never block the main flow.
            print(f"[onemcp-wrapup] audit emit failed event={event}: {exc}", flush=True)

    async def _fetch_chat_messages(
        self,
        chat_id: str,
        user_token: str = "",
    ) -> list[dict[str, Any]] | None:
        """Fetch full chat messages from OpenWebUI internal API using chat_id.

        Returns list of {role, content} dicts, or None if fetch fails.
        Needed because body.messages assistant.content is often empty in Action context.

        Auth priority: user_token (from __user__ ctx) > Valve OPENWEBUI_API_KEY.
        """
        if not chat_id:
            return None
        auth_token = user_token.strip() or self.valves.OPENWEBUI_API_KEY.strip()
        if not auth_token:
            return None

        base_url = self.valves.OPENWEBUI_URL.rstrip("/")
        headers = {
            "Authorization": f"Bearer {auth_token}",
            "Accept": "application/json",  # CRITICAL: without this, OpenWebUI serves HTML SPA
            "Content-Type": "application/json",
        }
        # Try common endpoint paths — OpenWebUI versions have used /api/v1/chats and /api/chat
        candidates = [
            f"{base_url}/api/v1/chats/{chat_id}",
            f"{base_url}/api/chats/{chat_id}",
        ]
        data = None
        errors: list[str] = []
        for url in candidates:
            try:
                async with httpx.AsyncClient(timeout=self.valves.TIMEOUT_SEC) as c:
                    r = await c.get(url, headers=headers)
                    ct = r.headers.get("content-type", "")
                    if r.status_code == 401:
                        errors.append(f"{url} → 401 Unauthorized (auth prefix={auth_token[:8]}..., len={len(auth_token)})")
                        continue
                    if r.status_code != 200:
                        errors.append(f"{url} → HTTP {r.status_code} ct={ct} body[:80]={r.text[:80]!r}")
                        continue
                    if "application/json" not in ct.lower():
                        errors.append(f"{url} → 200 but ct={ct} (SPA fallthrough?) body[:80]={r.text[:80]!r}")
                        continue
                    data = r.json()
                    print(f"[onemcp-wrapup] fetch chat OK via {url} (auth_prefix={auth_token[:6]}...)", flush=True)
                    break
            except Exception as exc:
                errors.append(f"{url} → exc {type(exc).__name__}: {exc}")
                continue
        if data is None:
            print(f"[onemcp-wrapup] fetch chat {chat_id} all endpoints failed. errors={errors}", flush=True)
            return None

        # OpenWebUI /api/v1/chats/{id} returns { chat: { history: { messages: {id: {role, content, ...}, ...} } } }
        chat_obj = data.get("chat") if isinstance(data, dict) else None
        if not isinstance(chat_obj, dict):
            print(f"[onemcp-wrapup] fetch chat: unexpected response shape keys={list(data.keys()) if isinstance(data, dict) else type(data)}", flush=True)
            return None

        history = chat_obj.get("history", {})
        msgs_dict = history.get("messages", {}) if isinstance(history, dict) else {}
        if not isinstance(msgs_dict, dict) or not msgs_dict:
            # Fallback: try chat_obj.messages (array shape)
            msgs_arr = chat_obj.get("messages")
            if isinstance(msgs_arr, list):
                return msgs_arr
            print(f"[onemcp-wrapup] fetch chat: empty history", flush=True)
            return None

        # Convert dict {id: msg} to ordered list following parent/children chain if present
        # Simple approach: sort by timestamp if available
        result = []
        for m in msgs_dict.values():
            if isinstance(m, dict):
                result.append(m)
        result.sort(key=lambda x: x.get("timestamp", 0))
        return result

    async def _llm_call(self, prompt: str, model: str) -> str:
        """Call LiteLLM with given prompt, return raw content string."""
        url = f"{self.valves.LITELLM_BASE_URL.rstrip('/')}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.valves.LITELLM_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "response_format": {"type": "json_object"},
            "temperature": 0.2,
            "max_tokens": 8192,  # allow long extraction output (multi-topic sessions)
        }
        async with httpx.AsyncClient(timeout=self.valves.TIMEOUT_SEC) as c:
            r = await c.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
        return data["choices"][0]["message"]["content"]

    @staticmethod
    def _make_slug(title: str) -> str:
        """Generate slug: lowercase alphanumeric + dashes + epoch suffix.

        Handles full Vietnamese diacritics via NFKD normalization (strips all
        combining marks) plus explicit đ→d mapping (đ is not decomposable).
        """
        import unicodedata
        s = title.lower()
        # đ / Đ not decomposed by NFKD → replace before normalize
        s = s.replace("đ", "d").replace("Đ", "d")
        # NFKD splits vowels+tone into base+combining mark; drop combining marks
        s = unicodedata.normalize("NFKD", s)
        s = "".join(ch for ch in s if not unicodedata.combining(ch))
        s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
        s = s[:140]
        if len(s) < 3:
            s = "artifact"
        return f"{s}-{int(time.time())}"

    @staticmethod
    def _transcript_from_messages(msgs: list[dict[str, Any]]) -> str:
        """Format messages list as role-prefixed transcript string.

        Robust to multiple OpenWebUI content shapes:
        - str
        - list of {"type": "text", "text": "..."} (multimodal)
        - list of other dicts (tries: text, content, value, message)
        - fallback: assistant may store body in top-level 'message' or 'reasoning_content'
        """
        lines = []
        for m in msgs:
            role = m.get("role", "?")
            content = m.get("content", "")
            text = ""
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                parts = []
                for c in content:
                    if isinstance(c, dict):
                        # Try common keys in order
                        for k in ("text", "content", "value", "message"):
                            v = c.get(k)
                            if isinstance(v, str) and v.strip():
                                parts.append(v)
                                break
                    elif isinstance(c, str):
                        parts.append(c)
                text = " ".join(parts)
            elif isinstance(content, dict):
                for k in ("text", "content", "value", "message"):
                    v = content.get(k)
                    if isinstance(v, str) and v.strip():
                        text = v
                        break
            # Fallback: OpenWebUI sometimes stores assistant output outside 'content'
            if not text.strip():
                for k in ("message", "reasoning_content", "response", "originalContent"):
                    v = m.get(k)
                    if isinstance(v, str) and v.strip():
                        text = v
                        break
            # OpenAI-style nested output: output=[{type:message, content:[{type:output_text, text:...}]}]
            if not text.strip():
                output = m.get("output")
                if isinstance(output, list):
                    parts = []
                    for block in output:
                        if not isinstance(block, dict):
                            continue
                        # message-type block contains list of content parts
                        inner = block.get("content")
                        if isinstance(inner, list):
                            for cp in inner:
                                if isinstance(cp, dict):
                                    t = cp.get("text") or cp.get("content")
                                    if isinstance(t, str) and t.strip():
                                        parts.append(t)
                        elif isinstance(inner, str) and inner.strip():
                            parts.append(inner)
                        # Some blocks put text directly on block.text
                        elif isinstance(block.get("text"), str) and block["text"].strip():
                            parts.append(block["text"])
                    if parts:
                        text = "\n".join(parts)
                elif isinstance(output, str) and output.strip():
                    text = output
            lines.append(f"[{role}] {text}")
        return "\n".join(lines)

    @staticmethod
    def _extract_artifact_id(result: Any) -> str:
        """Extract artifact ID from various MCP result shapes."""
        if not isinstance(result, dict):
            return "?"
        for k in ("id", "artifact_id", "artifactId"):
            if result.get(k):
                return str(result[k])
        art = result.get("artifact")
        if isinstance(art, dict) and art.get("id"):
            return str(art["id"])
        content = result.get("content", [])
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict):
                    text_body = str(item.get("text", ""))
                    m = re.search(r"artifact\s*#(\d+)", text_body, re.IGNORECASE)
                    if m:
                        return m.group(1)
                    m2 = re.search(r"\bid[:\s#]+(\d+)", text_body, re.IGNORECASE)
                    if m2:
                        return m2.group(1)
        return "?"

    @staticmethod
    def _draft_to_preview(artifact_type: str, draft: dict[str, Any]) -> str:
        """Render draft as markdown preview block for user confirmation."""
        emoji = _TYPE_EMOJI.get(artifact_type, "📄")
        label = _TYPE_LABEL.get(artifact_type, artifact_type.upper())
        header = f"### {emoji} {label} — Draft Preview\n"

        if artifact_type == "kb":
            title = str(draft.get("title", "")).strip() or "Untitled"
            problem = str(draft.get("problem", "")).strip()
            solution = str(draft.get("solution", "")).strip()
            related = str(draft.get("related", "")).strip()
            tags_val = draft.get("tags", [])
            tags_str = ", ".join(str(t) for t in tags_val) if isinstance(tags_val, list) else str(tags_val)
            body = (
                f"**Title:** {title}\n\n"
                f"**Problem:**\n{problem}\n\n"
                f"**Solution:**\n{solution}\n\n"
                f"**Related:** {related}\n\n"
                f"**Tags:** `{tags_str}`\n"
            )
        elif artifact_type == "report":
            title = str(draft.get("title", "")).strip() or "Untitled"
            context = str(draft.get("context", "")).strip()
            work_done = str(draft.get("work_done", "")).strip()
            outcome = str(draft.get("outcome", "")).strip()
            next_steps = str(draft.get("next_steps", "")).strip()
            tags_val = draft.get("tags", [])
            tags_str = ", ".join(str(t) for t in tags_val) if isinstance(tags_val, list) else str(tags_val)
            body = (
                f"**Title:** {title}\n\n"
                f"**Context:**\n{context}\n\n"
                f"**Work Done:**\n{work_done}\n\n"
                f"**Outcome:**\n{outcome}\n\n"
                f"**Next Steps:** {next_steps}\n\n"
                f"**Tags:** `{tags_str}`\n"
            )
        elif artifact_type == "research":
            title = str(draft.get("title", "")).strip() or "Untitled"
            question = str(draft.get("question", "")).strip()
            hypothesis = str(draft.get("hypothesis", "")).strip()
            findings = str(draft.get("findings", "")).strip()
            references = str(draft.get("references", "")).strip()
            conclusion = str(draft.get("conclusion", "")).strip()
            body = (
                f"**Title:** {title}\n\n"
                f"**Question:**\n{question}\n\n"
                f"**Hypothesis:** {hypothesis}\n\n"
                f"**Findings:**\n{findings}\n\n"
                f"**References:** {references}\n\n"
                f"**Conclusion:**\n{conclusion}\n"
            )
        else:
            body = f"```json\n{json.dumps(draft, ensure_ascii=False, indent=2)}\n```\n"

        return header + body

    @staticmethod
    def _build_submit_args(artifact_type: str, draft: dict[str, Any], slug: str) -> dict[str, Any]:
        """Build submit_artifact MCP call arguments for given type."""
        title = str(draft.get("title", "Untitled")).strip()
        tags_val = draft.get("tags", [])
        tags = [str(t).strip() for t in tags_val] if isinstance(tags_val, list) else [str(tags_val)]
        tags = [t for t in tags if t]

        if artifact_type == "kb":
            structured = {
                "problem": str(draft.get("problem", "")),
                "solution": str(draft.get("solution", "")),
                "related": str(draft.get("related", "")),
            }
        elif artifact_type == "report":
            structured = {
                "context": str(draft.get("context", "")),
                "work_done": str(draft.get("work_done", "")),
                "outcome": str(draft.get("outcome", "")),
                "next_steps": str(draft.get("next_steps", "")),
            }
        elif artifact_type == "research":
            structured = {
                "question": str(draft.get("question", "")),
                "hypothesis": str(draft.get("hypothesis", "")),
                "findings": str(draft.get("findings", "")),
                "references": str(draft.get("references", "")),
                "conclusion": str(draft.get("conclusion", "")),
            }
        else:
            structured = draft

        return {
            "type": artifact_type,
            "title": title,
            "slug": slug,
            "structured": structured,
            "tags": tags,
        }

    # ------------------------------------------------------------------ action

    async def action(
        self,
        body: dict[str, Any],
        __user__: dict[str, Any] | None = None,
        __event_emitter__: Callable[[dict], Awaitable[None]] | None = None,
        __event_call__: Callable[[dict], Awaitable[Any]] | None = None,
    ) -> str | None:

        async def status(msg: str, done: bool = False) -> None:
            if __event_emitter__:
                await __event_emitter__(
                    {"type": "status", "data": {"description": msg, "done": done}}
                )

        async def toast(kind: str, msg: str) -> None:
            """kind: success | warning | error | info"""
            if not __event_emitter__:
                return
            try:
                await __event_emitter__(
                    {"type": "notification", "data": {"type": kind, "content": msg}}
                )
            except Exception:
                pass

        async def emit_message(content: str) -> None:
            """Emit inline chat message (for preview)."""
            if __event_emitter__:
                await __event_emitter__(
                    {"type": "message", "data": {"content": content}}
                )

        try:
            # --- Resolve user ---
            onemcp_user, attribution = await self._resolve_username(body)

            # --- Get transcript (cap to MAX_TRANSCRIPT_MSG) ---
            all_msgs: list[dict[str, Any]] = body.get("messages", [])
            msgs = all_msgs[-self.valves.MAX_TRANSCRIPT_MSG :]

            if len(msgs) < 3:
                # Too short to be meaningful even before classifier
                await status("⚠️ Session quá ngắn để save", done=True)
                await toast("warning", "Session quá ngắn (< 3 messages). Hãy hoàn thành công việc trước khi save.")
                return "Session too short."

            transcript = self._transcript_from_messages(msgs)

            # --- Fallback: if assistant content empty in body, fetch full chat from OpenWebUI API ---
            def _assistant_content_missing(m_list: list[dict[str, Any]]) -> bool:
                for m in m_list:
                    if m.get("role") == "assistant":
                        c = m.get("content")
                        if isinstance(c, str) and c.strip():
                            return False
                        if isinstance(c, list) and any(
                            isinstance(x, dict) and str(x.get("text", "")).strip() for x in c
                        ):
                            return False
                # Any assistant present but none has content → missing
                return any(m.get("role") == "assistant" for m in m_list)

            if _assistant_content_missing(msgs):
                chat_id = body.get("chat_id") or body.get("id") or ""
                # Try user token from __user__ ctx first (many OpenWebUI versions inject it)
                user_token = ""
                if isinstance(__user__, dict):
                    user_token = str(
                        __user__.get("token")
                        or __user__.get("access_token")
                        or __user__.get("api_key")
                        or ""
                    ).strip()
                fetched = await self._fetch_chat_messages(str(chat_id), user_token)
                if fetched:
                    print(
                        f"[onemcp-wrapup] fetched {len(fetched)} msgs from OpenWebUI API chat_id={chat_id}",
                        flush=True,
                    )
                    msgs = fetched[-self.valves.MAX_TRANSCRIPT_MSG :]
                    transcript = self._transcript_from_messages(msgs)
                else:
                    if not self.valves.OPENWEBUI_API_KEY.strip():
                        await status("⚙️ Thiếu OPENWEBUI_API_KEY", done=True)
                        await toast(
                            "error",
                            "⚙️ Chat content chưa có sẵn trong body. Admin cần set Valve "
                            "OPENWEBUI_API_KEY (tạo tại Settings → Account → API Keys) "
                            "để Action fetch chat history đầy đủ.",
                        )
                        return "Config error: OPENWEBUI_API_KEY missing, cannot fetch chat."
                    else:
                        # Auth attempted but failed — likely wrong API key
                        await status("⚙️ OPENWEBUI_API_KEY invalid (401)", done=True)
                        await toast(
                            "error",
                            "⚙️ OPENWEBUI_API_KEY không hợp lệ (401 Unauthorized). "
                            "Vào Settings → Account → API Keys → tạo mới → paste vào Valve. "
                            "Hoặc paste JWT từ cookie 'token' (F12 → Application → Cookies).",
                        )
                        return "Config error: OPENWEBUI_API_KEY invalid (401)."

            # --- Debug: log role distribution to catch OpenWebUI msg shape issues ---
            role_counts: dict[str, int] = {}
            for m in msgs:
                r = str(m.get("role", "?"))
                role_counts[r] = role_counts.get(r, 0) + 1
            print(
                f"[onemcp-wrapup] msgs={len(msgs)} roles={role_counts} "
                f"transcript_len={len(transcript)} first_120={transcript[:120]!r} "
                f"__user__keys={list(__user__.keys()) if isinstance(__user__, dict) else type(__user__).__name__}",
                flush=True,
            )
            # Deep dump body keys to find alt sources for assistant content
            if len(transcript) < 500 and role_counts.get("assistant", 0) > 0:
                print(
                    f"[onemcp-wrapup] body top-level keys: {list(body.keys())} "
                    f"chat_id={body.get('chat_id')!r} id={body.get('id')!r}",
                    flush=True,
                )
                for i, m in enumerate(msgs):
                    if m.get("role") == "assistant":
                        keys = list(m.keys())
                        content = m.get("content")
                        ctype = type(content).__name__
                        preview = str(content)[:200] if content else "<empty>"
                        print(
                            f"[onemcp-wrapup] assistant#{i} keys={keys} "
                            f"content_type={ctype} content_preview={preview!r}",
                            flush=True,
                        )
                        break

            # --- Config check: fail-fast if LITELLM_API_KEY missing ---
            if not self.valves.LITELLM_API_KEY.strip():
                await status("⚙️ Thiếu cấu hình", done=True)
                await toast(
                    "error",
                    "⚙️ Action chưa được cấu hình: LITELLM_API_KEY trống. "
                    "Admin vui lòng vào Workspace → Actions → 🏁 End & Save → Valves → "
                    "set LITELLM_API_KEY (copy giá trị từ Action 📚 Submit KB).",
                )
                return "Config error: LITELLM_API_KEY empty."

            # --- Audit: attempted ---
            await self._audit("wrapup.attempted", onemcp_user, {"msg_count": len(msgs)})

            # --- Step 1: Hard block + soft redact ---
            await status("Kiểm tra secrets...")
            try:
                _check_hard_block(transcript)
            except RedactBlocked as e:
                await status(f"⛔ Blocked: {e.pattern_name}", done=True)
                await toast("error", f"⛔ Không thể save: transcript chứa {e.pattern_name}. Xoá secret rồi thử lại.")
                return f"Blocked: {e.pattern_name}"

            redact_result = _soft_redact(transcript)
            redacted_transcript = redact_result.text
            if redact_result.hits:
                print(f"[onemcp-wrapup] soft redact hits: {redact_result.hits}", flush=True)

            # --- Step 2: Classify ---
            await status("Phân loại session (classifier)...")

            # Call LLM directly (async) — wrapup-prompts classify() expects sync callable,
            # but we inline the async LLM call here to avoid blocking the event loop.
            # We replicate the classify logic inline here to stay async-native.
            is_en = _is_english_transcript(redacted_transcript)
            clf_template = _CLASSIFIER_PROMPT_EN if is_en else _CLASSIFIER_PROMPT_VN
            clf_prompt = clf_template.replace("{transcript}", redacted_transcript)
            llm_transport_error: str | None = None
            try:
                clf_raw = await self._llm_call(clf_prompt, self.valves.CLASSIFIER_MODEL)
                clf_raw = re.sub(r"^```(?:json)?\s*", "", clf_raw.strip(), flags=re.MULTILINE)
                clf_raw = re.sub(r"```\s*$", "", clf_raw.strip(), flags=re.MULTILINE)
                clf_result = json.loads(clf_raw.strip())
            except httpx.HTTPError as e:
                llm_transport_error = f"LLM transport error: {e}"
                clf_result = {"type": "SKIP", "confidence": 0.0, "reason": llm_transport_error}
            except Exception as e:
                clf_result = {"type": "SKIP", "confidence": 0.0, "reason": f"parse error: {e}"}

            # Distinguish transport/config error from real "session insufficient"
            if llm_transport_error:
                await status("❌ LLM call thất bại", done=True)
                await self._audit(
                    "wrapup.llm_error",
                    onemcp_user,
                    {"stage": "classifier", "error": llm_transport_error[:500]},
                )
                await toast(
                    "error",
                    f"❌ Không gọi được LLM classifier. {llm_transport_error}. "
                    "Kiểm tra Valve LITELLM_BASE_URL + LITELLM_API_KEY.",
                )
                return llm_transport_error

            artifact_type: str = str(clf_result.get("type", "SKIP"))
            confidence: float = float(clf_result.get("confidence", 0.0))
            clf_reason: str = str(clf_result.get("reason", ""))

            # Apply configurable confidence threshold (on top of classifier's own 0.5 check)
            threshold = self.valves.CLASSIFIER_CONFIDENCE_THRESHOLD
            if confidence < threshold and artifact_type != "SKIP":
                artifact_type = "SKIP"
                clf_reason = f"confidence {confidence:.2f} < threshold {threshold} → SKIP. Original: {clf_reason}"

            if artifact_type == "SKIP" or artifact_type not in ("kb", "report", "research"):
                await status("⚠️ Session chưa đủ nội dung để save", done=True)
                await self._audit(
                    "wrapup.skipped_classifier",
                    onemcp_user,
                    {
                        "reason": clf_reason,
                        "confidence": confidence,
                        "msg_count": len(msgs),
                        "role_counts": role_counts,
                    },
                )
                # Sanity check: if classifier claims 'no assistant' but assistant IS in transcript,
                # surface the mismatch so admin can diagnose (LLM hallucination vs real gap).
                assistant_count = role_counts.get("assistant", 0)
                hint = ""
                if assistant_count > 0 and "no assistant" in clf_reason.lower():
                    hint = (
                        f" ⓘ Debug: transcript CÓ {assistant_count} assistant msg — "
                        "classifier có thể đọc sai. Thử session dài hơn hoặc chuyển sang nút 📚."
                    )
                await toast(
                    "warning",
                    f"⚠️ Session chưa đủ nội dung để save. Lý do: {clf_reason}{hint}",
                )
                return f"SKIP: {clf_reason}"

            type_label = _TYPE_LABEL.get(artifact_type, artifact_type)
            await status(f"Classified → {type_label} (confidence={confidence:.2f})")

            # --- Step 3: Fetch template schema from OneMCP ---
            await status("Lấy template schema từ OneMCP...")
            template_schema: dict[str, Any] = {}
            try:
                tmpl_result = await self._rpc(
                    "tools/call",
                    {"name": "get_artifact_template", "arguments": {"type": artifact_type}},
                    onemcp_user,
                )
                # Template may be in content array or directly in result
                content = tmpl_result.get("content", [])
                if isinstance(content, list) and content:
                    first = content[0]
                    if isinstance(first, dict) and first.get("type") == "text":
                        try:
                            template_schema = json.loads(first.get("text", "{}"))
                        except Exception:
                            template_schema = {}
                elif isinstance(tmpl_result, dict):
                    template_schema = tmpl_result
            except Exception as exc:
                # Template fetch failure is non-fatal — proceed with empty schema
                print(f"[onemcp-wrapup] get_artifact_template failed: {exc}", flush=True)

            # --- Step 4: Extract structured fields ---
            await status(f"Trích xuất nội dung {type_label}...")
            ext_template = (
                _EXTRACTOR_PROMPTS[artifact_type][1]
                if is_en
                else _EXTRACTOR_PROMPTS[artifact_type][0]
            )
            ext_prompt = ext_template.replace("{transcript}", redacted_transcript)

            draft: dict[str, Any] = {}
            for attempt in range(2):
                try:
                    ext_raw = await self._llm_call(ext_prompt, self.valves.EXTRACTOR_MODEL)
                    ext_raw = re.sub(r"^```(?:json)?\s*", "", ext_raw.strip(), flags=re.MULTILINE)
                    ext_raw = re.sub(r"```\s*$", "", ext_raw.strip(), flags=re.MULTILINE)
                    draft = json.loads(ext_raw.strip())
                    break  # parse success
                except Exception as e:
                    if attempt == 1:
                        # Both attempts failed
                        await status("⛔ Extract parse fail sau 2 lần retry", done=True)
                        await toast("error", f"⛔ Extract lỗi: không parse được JSON từ LLM sau 2 lần thử.")
                        print(f"[onemcp-wrapup] extract parse failed twice: {e}", flush=True)
                        return f"Extract parse error: {e}"
                    await status(f"Extract parse fail lần {attempt + 1}, retry...")

            # --- Step 5: Gatekeeper check ---
            await status("Gatekeeper kiểm tra chất lượng draft...")
            ok, reject_reason = _wrapup_gatekeeper(artifact_type, draft, redacted_transcript)
            if not ok:
                await status(f"⚠️ Gatekeeper reject: {reject_reason}", done=True)
                await self._audit(
                    "wrapup.rejected_gatekeeper",
                    onemcp_user,
                    {"type": artifact_type, "reason": reject_reason, "draft_title": str(draft.get("title", ""))},
                )
                await toast(
                    "warning",
                    f"⚠️ Draft chưa đạt yêu cầu: {reject_reason}. Session có thể chưa kết thúc hoặc chưa đủ nội dung.",
                )
                return f"Gatekeeper reject: {reject_reason}"

            # --- Step 6: Preview + confirm UI ---
            preview_text = self._draft_to_preview(artifact_type, draft)
            confirm_footer = (
                "\n\n---\n"
                "**Submit artifact này vào OneMCP?**\n\n"
                "Nhấn **Confirm** để lưu | **Cancel** để huỷ"
            )

            await emit_message(preview_text + confirm_footer)

            # Use __event_call__ for interactive confirm/cancel if available.
            # Falls back to auto-submit if OpenWebUI doesn't support event_call.
            confirmed = False
            if __event_call__:
                try:
                    response = await __event_call__(
                        {
                            "type": "input",
                            "data": {
                                "title": f"🏁 End & Save — {type_label}",
                                "message": "Xác nhận submit artifact này vào OneMCP?",
                                "placeholder": "Nhập 'confirm' để lưu hoặc bỏ trống để huỷ",
                            },
                        }
                    )
                    user_input = str(response or "").strip().lower()
                    confirmed = user_input in ("confirm", "yes", "y", "ok", "có", "x")
                except Exception as exc:
                    # event_call unavailable or timed out — auto-cancel for safety
                    print(f"[onemcp-wrapup] event_call failed: {exc}", flush=True)
                    confirmed = False
            else:
                # No interactive API — emit instructions via message and auto-cancel.
                # User must re-click after reviewing.
                await toast(
                    "info",
                    "Preview đã hiển thị. OpenWebUI không hỗ trợ interactive confirm — "
                    "click 🏁 lần nữa sau khi review để submit.",
                )
                await self._audit(
                    "wrapup.cancelled",
                    onemcp_user,
                    {"type": artifact_type, "reason": "no_event_call_api", "auto": True},
                )
                return "Preview shown. Re-click to submit (no interactive API)."

            if not confirmed:
                await status("❌ Đã huỷ", done=True)
                await self._audit(
                    "wrapup.cancelled",
                    onemcp_user,
                    {"type": artifact_type, "title": str(draft.get("title", ""))},
                )
                await toast("info", "Đã huỷ lưu session.")
                return "Cancelled."

            # --- Step 7: Submit to OneMCP ---
            await status("Đang submit vào OneMCP...")
            slug = self._make_slug(str(draft.get("title", "artifact")))
            submit_args = self._build_submit_args(artifact_type, draft, slug)

            result = await self._rpc("tools/call", {"name": "submit_artifact", "arguments": submit_args}, onemcp_user)
            print(
                f"[onemcp-wrapup] submit response: {json.dumps(result)[:500]}"
                f" type={artifact_type} attribution={attribution} user={onemcp_user}",
                flush=True,
            )

            aid = self._extract_artifact_id(result)
            portal_url = f"{self.valves.ONEMCP_URL.rstrip('/')}/artifacts/{aid}"
            success_msg = f"✅ {_TYPE_EMOJI.get(artifact_type, '📄')} {type_label} #{aid} đã submit (pending review). {portal_url}"

            await self._audit(
                "wrapup.submitted",
                onemcp_user,
                {
                    "type": artifact_type,
                    "artifact_id": aid,
                    "title": str(draft.get("title", "")),
                    "attribution": attribution,
                    "msg_count": len(msgs),
                },
            )
            await status(f"✅ Artifact #{aid} submitted — {portal_url}", done=True)
            await toast("success", success_msg)
            return f"Submitted {artifact_type} #{aid} (pending). Verify: {portal_url}"

        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            print(f"[onemcp-wrapup] unhandled error: {err}", flush=True)
            await status(f"⛔ Error: {err}", done=True)
            await toast("error", f"🏁 Wrapup lỗi: {err}")
            return f"Error: {e}"
