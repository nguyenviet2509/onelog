"""
wrapup-prompts-test.py — Local test suite for wrapup-prompts.py.

5 fixture transcripts:
  1. chit-chat            → expect SKIP
  2. real troubleshoot    → expect kb
  3. design discussion    → expect research
  4. task recap           → expect report
  5. incomplete/unresolved → expect SKIP

Mock LLM returns deterministic outputs based on prompt content inspection.
Verifies: classifier type, extractor schema fields, gatekeeper reject/accept.

Run: python infra/openwebui/actions/wrapup-prompts-test.py
"""

import io
import json
import sys
import traceback
from typing import Any

# Force UTF-8 output on Windows to handle Vietnamese + arrow chars
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# Resolve sibling import (same directory)
import importlib.util
import pathlib

_THIS_DIR = pathlib.Path(__file__).parent
_MODULE_PATH = _THIS_DIR / "wrapup-prompts.py"
spec = importlib.util.spec_from_file_location("wrapup_prompts", _MODULE_PATH)
wrapup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapup)


# ============================================================================
# Fixtures
# ============================================================================

TRANSCRIPT_CHITCHAT = """
[user] chào buổi sáng!
[assistant] Chào bạn! Hôm nay tôi có thể giúp gì cho bạn?
[user] hôm qua mưa to quá
[assistant] Vâng, thời tiết hôm qua khá xấu. Bạn có cần làm gì hôm nay không?
[user] thôi mình nghỉ ngơi tí
[assistant] Được, nghỉ ngơi thôi. Khi cần thì hú mình nhé!
[user] ok thanks
[assistant] Không có gì!
""".strip()

TRANSCRIPT_TROUBLESHOOT_KB = """
[user] nginx của mình đang bị lỗi 502 khi upstream timeout, log thấy: upstream timed out (110: Connection timed out) while reading response header from upstream
[assistant] Lỗi này do nginx timeout trước khi backend kịp respond. Mặc định proxy_read_timeout là 60s. Bạn kiểm tra upstream xử lý mất bao lâu?
[user] backend mất khoảng 90-120s cho các request nặng, xử lý PDF conversion
[assistant] Vậy thì cần tăng timeout. Sửa nginx.conf như sau:
```
proxy_read_timeout 300s;
proxy_connect_timeout 30s;
proxy_send_timeout 300s;
```
Sau đó: `nginx -t && nginx -s reload`
[user] ok mình sửa rồi reload, test thử curl request nặng... pass rồi, không còn 502 nữa
[assistant] Tốt! Vậy là fix xong. Lỗi do proxy_read_timeout 60s quá thấp so với thời gian xử lý PDF 90-120s của backend. Sau khi tăng lên 300s thì nginx chờ đủ lâu.
[user] cảm ơn, note lại để không quên
[assistant] Đã fix! Summary: nginx 502 do upstream timeout, fix bằng cách tăng proxy_read_timeout 300s trong nginx.conf.
""".strip()

TRANSCRIPT_RESEARCH = """
[user] mình đang so sánh Qdrant vs Weaviate để làm vector DB cho RAG pipeline của onelog. Tiêu chí: self-hosted, VPS 4GB RAM, 100K docs 1536-dim vectors, REST API.
[assistant] Đây là so sánh chi tiết:

**Qdrant:**
- RAM: ~300-400MB với 100K vectors 1536-dim (nếu dùng on-disk index)
- API: Native REST + gRPC
- Filter: payload filtering tốt, range/match queries
- Deploy: single binary, Docker image ~150MB

**Weaviate:**
- RAM: ~1-2GB minimum (JVM overhead)
- API: GraphQL native, REST secondary
- Module system: text2vec, generative, etc. → tốt nhưng nặng
- Deploy: phức tạp hơn nếu dùng modules

[user] benchmark thì sao? mình thấy có bài Qdrant nhanh hơn nhiều
[assistant] Đúng. Từ benchmark ANN-benchmarks và Qdrant own benchmarks: Qdrant nhanh hơn Weaviate 2-3x trên single-node ANN search với dataset 1M vectors. Weaviate cải thiện nhiều ở v1.23 nhưng vẫn chậm hơn Qdrant trong single-node scenario.

[user] references có không?
[assistant] - https://qdrant.tech/benchmarks/ (official Qdrant benchmarks)
- https://ann-benchmarks.com (neutral ANN benchmarks)
- Weaviate blog: v1.23 performance improvements

[user] ok kết luận là dùng Qdrant đúng không, phù hợp hơn cho VPS 4GB?
[assistant] Đúng. Kết luận: chọn Qdrant cho onelog RAG pipeline.
Lý do: RAM footprint thấp (~400MB vs ~1.5GB Weaviate), REST native dễ integrate, benchmark tốt hơn trên single-node. Weaviate phù hợp hơn khi cần multi-tenancy module-based hoặc GraphQL. Defer Weaviate đến khi scale thật sự cần.
""".strip()

TRANSCRIPT_REPORT_TASK = """
[user] bắt đầu migrate postgres 14 lên 15 trên onelog-vps. Plan: backup → install pg15 → pg_upgrade → verify
[assistant] Ok, bắt đầu thôi. Trước tiên backup:
```bash
pg_dump -Fc onelog_db > /backup/onelog_db_pg14_$(date +%Y%m%d).dump
```
[user] backup xong rồi, 2.3GB. giờ install pg15
[assistant] Install song song:
```bash
apt install postgresql-15
# Verify
pg_lsclusters
```
[user] pg15 đã install, có 2 cluster: 14/main và 15/main. Chạy pg_upgrade --check trước
[assistant] Đúng rồi. Chạy:
```bash
pg_upgrade --check \
  -b /usr/lib/postgresql/14/bin \
  -B /usr/lib/postgresql/15/bin \
  -d /var/lib/postgresql/14/main \
  -D /var/lib/postgresql/15/main
```
[user] check pass, không có issue. Chạy upgrade thật
[assistant] Ok chạy thật (stop service trước):
```bash
systemctl stop postgresql@14-main
pg_upgrade \
  -b /usr/lib/postgresql/14/bin \
  -B /usr/lib/postgresql/15/bin \
  -d /var/lib/postgresql/14/main \
  -D /var/lib/postgresql/15/main
systemctl start postgresql@15-main
```
[user] xong rồi, mất 6 phút. verify app kết nối được rồi, select count query ok, không có lỗi
[assistant] Hoàn thành! Postgres 14 → 15 migrate thành công trên onelog-vps. App kết nối bình thường. Giữ backup pg14 thêm 7 ngày rồi xóa. Next: chạy ANALYZE để update stats cho pg15.
""".strip()

TRANSCRIPT_INCOMPLETE = """
[user] mình đang gặp lỗi với docker compose, container restart liên tục
[assistant] Bạn có thể share log của container không? `docker logs <container-name> --tail 50`
[user] để mình chạy xem
[assistant] Ok, share log ra đây mình xem với.
[user] ừ đợi tí
""".strip()


# ============================================================================
# Mock LLM caller
# ============================================================================

def make_mock_llm(responses: dict[str, str]):
    """Return a mock llm_call that inspects prompt content to pick response.

    responses: dict mapping keyword → JSON string response.
    Matching: first keyword found in prompt (case-insensitive) wins.
    Fallback: last entry (assume it's the default).
    """
    def mock_llm(prompt: str) -> str:
        prompt_lower = prompt.lower()
        for keyword, response in responses.items():
            if keyword.lower() in prompt_lower:
                return response
        # Fallback: return last value
        return list(responses.values())[-1]
    return mock_llm


# Classifier mock: detects transcript content from injected prompt
CLASSIFIER_MOCK = make_mock_llm({
    # Chit-chat fixture: short, no technical content
    "hôm qua mưa": json.dumps({"type": "SKIP", "confidence": 0.95, "reason": "chit-chat không có nội dung technical"}),
    # KB troubleshoot fixture
    "502 khi upstream timeout": json.dumps({"type": "kb", "confidence": 0.92, "reason": "bug nginx 502 đã fix và verify với proxy_read_timeout"}),
    # Research fixture
    "qdrant vs weaviate": json.dumps({"type": "research", "confidence": 0.88, "reason": "so sánh và phân tích kỹ thuật, kết luận rõ ràng"}),
    # Report fixture
    "migrate postgres": json.dumps({"type": "report", "confidence": 0.91, "reason": "task migrate PG hoàn thành với kết quả rõ ràng"}),
    # Incomplete fixture
    "đợi tí": json.dumps({"type": "SKIP", "confidence": 0.97, "reason": "session chưa kết thúc, không có outcome"}),
})

# KB extractor mock
KB_EXTRACTOR_MOCK = make_mock_llm({
    "502 khi upstream timeout": json.dumps({
        "title": "nginx 502 upstream timeout khi backend xử lý PDF conversion",
        "problem": "Nginx trả 502 Bad Gateway khi upstream backend mất 90-120s xử lý PDF conversion.\nLog: `upstream timed out (110: Connection timed out) while reading response header from upstream`",
        "solution": "Tăng timeout trong nginx.conf:\n```\nproxy_read_timeout 300s;\nproxy_connect_timeout 30s;\nproxy_send_timeout 300s;\n```\nSau đó: `nginx -t && nginx -s reload`. Verify: curl request nặng không còn 502.",
        "related": "",
        "tags": ["nginx", "http_502", "timeout", "upstream", "pdf_conversion"],
    }),
})

# Report extractor mock
REPORT_EXTRACTOR_MOCK = make_mock_llm({
    "migrate postgres": json.dumps({
        "title": "migrate postgres 14 → 15 trên onelog-vps thành công",
        "context": "Postgres 14 sắp EOL. Cần nâng lên 15 để đảm bảo security update liên tục.",
        "work_done": "1. Backup full DB với pg_dump (2.3GB).\n2. Install postgresql-15 song song.\n3. pg_upgrade --check → pass.\n4. Stop pg14, chạy pg_upgrade thật (6 phút).\n5. Start pg15, verify app kết nối + query ok.",
        "outcome": "Postgres v15 đang chạy trên onelog-vps. App kết nối bình thường, select count query ok. Backup pg14 giữ 7 ngày.",
        "next_steps": "Chạy ANALYZE để update stats. Xóa backup pg14 sau 7 ngày nếu không có vấn đề.",
        "tags": ["postgres", "migration", "database", "onelog_vps"],
    }),
})

# Research extractor mock
RESEARCH_EXTRACTOR_MOCK = make_mock_llm({
    "qdrant vs weaviate": json.dumps({
        "title": "so sánh Qdrant vs Weaviate cho RAG pipeline onelog",
        "question": "Chọn vector DB nào cho RAG pipeline: Qdrant hay Weaviate? Tiêu chí: self-hosted VPS 4GB, 100K docs 1536-dim, REST API.",
        "hypothesis": "Qdrant nhẹ hơn, phù hợp VPS nhỏ. Weaviate mạnh hơn nhưng nặng hơn.",
        "findings": "Qdrant: ~300-400MB RAM, REST native, filter tốt, Docker image 150MB. Weaviate: ~1-2GB RAM minimum, GraphQL native, module system phức tạp. Benchmark: Qdrant nhanh hơn Weaviate 2-3x trên single-node ANN search (từ ann-benchmarks.com và Qdrant benchmarks).",
        "references": "- https://qdrant.tech/benchmarks/\n- https://ann-benchmarks.com\n- Weaviate blog: v1.23 performance improvements",
        "conclusion": "Chọn Qdrant cho onelog RAG pipeline. Lý do: RAM thấp (~400MB), REST native, benchmark tốt. Defer Weaviate đến khi cần GraphQL hoặc module-based multi-tenancy.",
    }),
})


# ============================================================================
# Test runner
# ============================================================================

class TestResult:
    def __init__(self, name: str):
        self.name = name
        self.passed = True
        self.failures: list[str] = []

    def assert_eq(self, actual: Any, expected: Any, msg: str = "") -> None:
        if actual != expected:
            self.passed = False
            self.failures.append(f"  FAIL {msg}: expected {expected!r}, got {actual!r}")

    def assert_true(self, condition: bool, msg: str = "") -> None:
        if not condition:
            self.passed = False
            self.failures.append(f"  FAIL {msg}")

    def assert_in(self, key: str, container: Any, msg: str = "") -> None:
        if key not in container:
            self.passed = False
            self.failures.append(f"  FAIL {msg}: key {key!r} not in {list(container.keys()) if isinstance(container, dict) else container!r}")

    def report(self) -> str:
        status = "PASS" if self.passed else "FAIL"
        lines = [f"[{status}] {self.name}"]
        lines.extend(self.failures)
        return "\n".join(lines)


def run_test_1_chitchat():
    """chit-chat transcript → classifier SKIP."""
    t = TestResult("Test 1: chit-chat → SKIP")
    result = wrapup.classify(TRANSCRIPT_CHITCHAT, CLASSIFIER_MOCK)
    t.assert_eq(result["type"], "SKIP", "classifier type")
    t.assert_true(result["confidence"] > 0.0, "confidence > 0")
    return t


def run_test_2_kb_troubleshoot():
    """Real troubleshoot → classifier kb, extractor fills required fields, gatekeeper accepts."""
    t = TestResult("Test 2: troubleshoot → kb (classify + extract + gatekeeper)")

    # Classifier
    cls = wrapup.classify(TRANSCRIPT_TROUBLESHOOT_KB, CLASSIFIER_MOCK)
    t.assert_eq(cls["type"], "kb", "classifier type")
    t.assert_true(cls["confidence"] >= 0.7, f"confidence >= 0.7 (got {cls['confidence']})")

    # Extractor
    draft = wrapup.extract("kb", TRANSCRIPT_TROUBLESHOOT_KB, {}, KB_EXTRACTOR_MOCK)
    t.assert_true("error" not in draft, "no extraction error")
    for field in ("title", "problem", "solution", "tags"):
        t.assert_in(field, draft, f"extractor field '{field}' present")
    t.assert_true(len(draft.get("title", "")) >= 15, "title length >= 15")
    t.assert_true(len(draft.get("problem", "")) >= 40, "problem length >= 40")
    t.assert_true(len(draft.get("solution", "")) >= 40, "solution length >= 40")
    t.assert_true(isinstance(draft.get("tags"), list), "tags is list")

    # Gatekeeper — should accept
    ok, reason = wrapup.gatekeeper_check("kb", draft, TRANSCRIPT_TROUBLESHOOT_KB)
    t.assert_true(ok, f"gatekeeper accept (got reason: {reason!r})")

    return t


def run_test_3_research():
    """Design/research discussion → classifier research, extractor fills required fields, gatekeeper accepts."""
    t = TestResult("Test 3: design discussion → research (classify + extract + gatekeeper)")

    # Classifier
    cls = wrapup.classify(TRANSCRIPT_RESEARCH, CLASSIFIER_MOCK)
    t.assert_eq(cls["type"], "research", "classifier type")
    t.assert_true(cls["confidence"] >= 0.7, f"confidence >= 0.7 (got {cls['confidence']})")

    # Extractor
    draft = wrapup.extract("research", TRANSCRIPT_RESEARCH, {}, RESEARCH_EXTRACTOR_MOCK)
    t.assert_true("error" not in draft, "no extraction error")
    for field in ("title", "question", "findings", "conclusion"):
        t.assert_in(field, draft, f"extractor field '{field}' present")
    t.assert_true(len(draft.get("findings", "")) >= 80, f"findings length >= 80 (got {len(draft.get('findings',''))})")
    t.assert_true(len(draft.get("conclusion", "")) >= 30, "conclusion length >= 30")

    # Gatekeeper — should accept
    ok, reason = wrapup.gatekeeper_check("research", draft, TRANSCRIPT_RESEARCH)
    t.assert_true(ok, f"gatekeeper accept (got reason: {reason!r})")

    return t


def run_test_4_report():
    """Task recap → classifier report, extractor fills required fields, gatekeeper accepts."""
    t = TestResult("Test 4: task recap → report (classify + extract + gatekeeper)")

    # Classifier
    cls = wrapup.classify(TRANSCRIPT_REPORT_TASK, CLASSIFIER_MOCK)
    t.assert_eq(cls["type"], "report", "classifier type")
    t.assert_true(cls["confidence"] >= 0.7, f"confidence >= 0.7 (got {cls['confidence']})")

    # Extractor
    draft = wrapup.extract("report", TRANSCRIPT_REPORT_TASK, {}, REPORT_EXTRACTOR_MOCK)
    t.assert_true("error" not in draft, "no extraction error")
    for field in ("title", "context", "work_done", "outcome"):
        t.assert_in(field, draft, f"extractor field '{field}' present")
    t.assert_true(len(draft.get("work_done", "")) >= 50, f"work_done length >= 50 (got {len(draft.get('work_done',''))})")
    t.assert_true(len(draft.get("outcome", "")) >= 30, f"outcome length >= 30 (got {len(draft.get('outcome',''))})")

    # Gatekeeper — should accept
    ok, reason = wrapup.gatekeeper_check("report", draft, TRANSCRIPT_REPORT_TASK)
    t.assert_true(ok, f"gatekeeper accept (got reason: {reason!r})")

    return t


def run_test_5_incomplete():
    """Incomplete/unresolved session → classifier SKIP + gatekeeper rejects bad drafts."""
    t = TestResult("Test 5: incomplete/unresolved → SKIP + gatekeeper rejects bad drafts")

    # Classifier should SKIP
    cls = wrapup.classify(TRANSCRIPT_INCOMPLETE, CLASSIFIER_MOCK)
    t.assert_eq(cls["type"], "SKIP", "classifier type SKIP")

    # Gatekeeper should reject a known-bad KB draft (LLM apology phrases)
    bad_draft_apology = {
        "title": "docker container restart issue",
        "problem": "Tôi không chắc nguyên nhân chính xác của lỗi này.",
        "solution": "As an AI, I cannot determine the exact fix without more logs.",
        "related": "",
        "tags": ["docker"],
    }
    ok, reason = wrapup.gatekeeper_check("kb", bad_draft_apology, TRANSCRIPT_INCOMPLETE)
    t.assert_true(not ok, f"gatekeeper rejects apology draft (reason: {reason!r})")

    # Gatekeeper should reject a too-short KB draft
    short_draft = {
        "title": "docker issue",
        "problem": "container fail",
        "solution": "fix it",
        "related": "",
        "tags": [],
    }
    ok2, reason2 = wrapup.gatekeeper_check("kb", short_draft, TRANSCRIPT_INCOMPLETE)
    t.assert_true(not ok2, f"gatekeeper rejects short draft (reason: {reason2!r})")

    # Gatekeeper should reject incomplete transcript for not having enough technical messages
    ok3, reason3 = wrapup.gatekeeper_check("report", {
        "title": "some report title here",
        "context": "some context text here for the report",
        "work_done": "some work done in this session with the user",
        "outcome": "some outcome of the work done in this session indeed",
        "next_steps": "",
        "tags": [],
    }, TRANSCRIPT_INCOMPLETE)
    t.assert_true(not ok3, f"gatekeeper rejects insufficient technical messages (reason: {reason3!r})")

    return t


# ============================================================================
# Bonus: prompt token estimate check
# ============================================================================

def check_prompt_token_budgets():
    """Verify all prompts are < 1500 tokens (len/4 heuristic)."""
    results = []
    sample_transcript = "[user] test\n[assistant] test"
    prompts_to_check = [
        ("CLASSIFIER_VN", wrapup.CLASSIFIER_PROMPT_VN.replace("{transcript}", sample_transcript)),
        ("CLASSIFIER_EN", wrapup.CLASSIFIER_PROMPT_EN.replace("{transcript}", sample_transcript)),
        ("KB_EXTRACTOR_VN", wrapup.KB_EXTRACTOR_PROMPT_VN.replace("{transcript}", sample_transcript)),
        ("KB_EXTRACTOR_EN", wrapup.KB_EXTRACTOR_PROMPT_EN.replace("{transcript}", sample_transcript)),
        ("REPORT_EXTRACTOR_VN", wrapup.REPORT_EXTRACTOR_PROMPT_VN.replace("{transcript}", sample_transcript)),
        ("REPORT_EXTRACTOR_EN", wrapup.REPORT_EXTRACTOR_PROMPT_EN.replace("{transcript}", sample_transcript)),
        ("RESEARCH_EXTRACTOR_VN", wrapup.RESEARCH_EXTRACTOR_PROMPT_VN.replace("{transcript}", sample_transcript)),
        ("RESEARCH_EXTRACTOR_EN", wrapup.RESEARCH_EXTRACTOR_PROMPT_EN.replace("{transcript}", sample_transcript)),
    ]
    budget_ok = True
    for name, prompt_text in prompts_to_check:
        est = wrapup.get_prompt_token_estimate(prompt_text)
        status = "OK" if est < 1500 else "OVER BUDGET"
        if est >= 1500:
            budget_ok = False
        results.append(f"  {status:12s} {name}: ~{est} tokens")
    return budget_ok, results


# ============================================================================
# Main
# ============================================================================

if __name__ == "__main__":
    print("=" * 60)
    print("wrapup-prompts test suite")
    print("=" * 60)

    tests = [
        run_test_1_chitchat,
        run_test_2_kb_troubleshoot,
        run_test_3_research,
        run_test_4_report,
        run_test_5_incomplete,
    ]

    results = []
    for test_fn in tests:
        try:
            result = test_fn()
        except Exception as e:
            result = TestResult(test_fn.__name__)
            result.passed = False
            result.failures.append(f"  EXCEPTION: {e}")
            result.failures.append(traceback.format_exc())
        results.append(result)
        print(result.report())

    passed = sum(1 for r in results if r.passed)
    total = len(results)

    print()
    print("=" * 60)
    print(f"Results: {passed}/{total} passed")

    print()
    print("Prompt token budget check (< 1500 tokens each):")
    budget_ok, budget_lines = check_prompt_token_budgets()
    for line in budget_lines:
        print(line)
    if budget_ok:
        print("  All prompts within budget.")
    else:
        print("  WARNING: some prompts over 1500 token estimate!")

    print("=" * 60)

    # Exit non-zero if any test failed
    if passed < total or not budget_ok:
        sys.exit(1)
    else:
        print("All tests passed.")
        sys.exit(0)
