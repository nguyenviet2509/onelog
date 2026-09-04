# Brainstorm: OpenWebUI Context Optimization for Deep-Trace Ops Chats

**Session**: 260822-0957 · Asia/Saigon
**Trigger**: Chat "Kiểm Tra Host Mailer Shell" hit 2M tokens, DeepSeek 400 ContextWindowExceededError; fallback chain broken (empty OPENAI + ANTHROPIC keys)
**Decision**: Option A Combo — Paid Gemini 2.5 Pro fallback + client-side bloat control
**Status**: Waiting for user to enable Google Cloud billing for GEMINI_API_KEY

## Problem statement

DeepSeek Chat paid tier = 1M context ceiling (hard limit, không unlimited). OpenWebUI gửi FULL chat history + raw tool outputs mỗi turn → deep debug chat 10-20 turn dễ vượt 1M. Không có model 2M+ ở free tier hiện tại. Anh cần deep-trace debug 30-50 turn cho ops workflow phòng KT.

**Root cause 2 layer:**
1. **Ceiling**: Model context max, kể cả paid (DeepSeek 1M, GPT-4.1 1M, Gemini Flash 1M, Claude 200k std)
2. **Bloat**: OpenWebUI accumulate raw tool outputs (VL query trả 1000 log rows = 100-500k tokens/call) vào history vô hạn

Trả phí model chỉ fix layer 1. Cần combo cả 2 layer để deep-trace pattern work bền.

## Approaches evaluated

| Option | Ceiling fix | Bloat fix | Cost/tháng | Deep-turn cap |
|---|---|---|---|---|
| **A (Combo)** | Gemini 2.5 Pro paid = 2M fallback | Filter + VL cap + summary | ~$3-5 | 30-50 turn |
| B (Free aggressive) | Không đổi (1M) | Filter + VL cap + summary | 0đ | 10-20 turn |
| C (OpenAI paid) | GPT-4.1 = 1M (cùng ceiling) | Không tự có | $10-30+ | 10-20 turn |

**Chọn A**: fit deep-trace pattern, cost thấp (chỉ trigger khi vượt 1M), giữ hạ tầng đã build (LiteLLM + Filter + prompt rules).

## Final solution — Option A Combo

### Layer 1 — Ceiling: Gemini 2.5 Pro paid fallback

**Prerequisite (user manual)**:
1. Vào [Google Cloud Console → Billing](https://console.cloud.google.com/billing)
2. Link billing account với project đang sở hữu `GEMINI_API_KEY`
3. Enable "Generative Language API" trong project (nếu chưa)
4. Verify: `curl` gemini-2.5-pro với key hiện tại → không còn `RESOURCE_EXHAUSTED`
5. Ping lại session, tôi deploy config

**LiteLLM config** ([infra/litellm/config.yaml](../../infra/litellm/config.yaml)) — add:
```yaml
- model_name: gemini-pro
  litellm_params:
    model: gemini/gemini-2.5-pro
    api_key: os.environ/GEMINI_API_KEY
    max_input_tokens: 2097152

router_settings:
  context_window_fallbacks:
    - deepseek: ["gemini-pro"]
    - gemini-flash: ["gemini-pro"]
```

**Behavior**: DeepSeek trả 400 context exceed → LiteLLM tự route sang Gemini 2.5 Pro → user không thấy gián đoạn, chỉ thấy trong log `fallback=true`.

**Cost estimate**: Bulk traffic (< 1M) vẫn qua DeepSeek (rẻ hơn). Gemini Pro chỉ trigger khi vượt 1M — hiếm nếu Layer 2 hoạt động. Ước tính 5-10 requests/ngày qua Gemini Pro với ~1.5M tokens avg = ~$0.15-0.3/ngày ≈ $5-10/tháng worst case.

### Layer 2 — Bloat: Client-side controls

**A. Filter trim-tool-history** (đã cài git, chưa enable UI)
File: [infra/openwebui/functions/trim-tool-history.py](../../infra/openwebui/functions/trim-tool-history.py)
- Truncate tool outputs cũ > 8000 chars → middle-cut giữ đầu+cuối
- Hard cap tổng 600k chars (~150k tokens)
- Cần install: Admin → Functions → + Add → paste code → Enable

**B. VL query row cap** (system prompt update)
Ép LLM luôn append `| limit 50` (hoặc `| head 50`) vào LogsQL query. Không cho query trần trả 1000+ rows.

Thêm rule vào [infra/openwebui/system-prompt-ops.md](../../infra/openwebui/system-prompt-ops.md):
```
9c. Cap VL query output — LUÔN limit rows:
   - Fetch log: append `| limit 50` cuối query (VD `host:X _msg:"error" | limit 50`)
   - Stats query: dùng `| stats` tự bounded, không cần cap
   - Chỉ tăng limit khi user explicit request ("show me 500 log")
   - Lý do: raw log 1000 rows = 300k+ tokens = 3-5 turn là blow context
```

**C. Summarize old turns** (system prompt rule)
Ép LLM tự tóm tắt tool outputs turn cũ trước khi advance:
```
9d. Sau mỗi 3-5 turn tool-heavy, tự COMPRESS context:
   - Đọc lại tool output turns cũ
   - Tóm tắt key findings vào 1 message ngắn (< 500 tokens)
   - Reference "Turn X đã tìm ra: ..." thay vì re-quote raw output
   Tránh re-fetch cùng data (đã có trong history compressed).
```

### Layer 3 — UX Warning banner

Extend `trim-tool-history.py` với logic emit event khi chat vượt threshold:
- 500k tokens (soft warning): banner "⚠️ Chat lớn (~500k tokens). Muốn tạo new chat cho câu hỏi khác không?"
- 900k tokens (hard warning): banner "🚨 Sắp hit DeepSeek limit. Fork sang new chat được recommend."

OpenWebUI Filter Function có `__event_emitter__` param cho phép push notification vào UI. Extend `inlet()` để check total tokens estimate và emit.

## Implementation checklist

**User (prerequisite)**:
- [ ] Enable Google Cloud billing cho project sở hữu GEMINI_API_KEY
- [ ] Verify quota gemini-2.5-pro available
- [ ] Ping session — tôi triển khai code

**Tôi (sau khi user done prerequisite)**:
- [ ] `infra/litellm/config.yaml`: add `gemini-pro` model + `context_window_fallbacks`
- [ ] `infra/openwebui/functions/trim-tool-history.py`: extend with UX warning via `__event_emitter__`
- [ ] `infra/openwebui/system-prompt-ops.md`: add rule 9c (VL cap) + 9d (summarize)
- [ ] Test: gửi chat lớn, verify fallback chain deepseek → gemini-pro không rớt
- [ ] Test: Filter emit warning ở 500k tokens threshold
- [ ] Commit + push + reset VPS + smoke test
- [ ] Update docs với runbook rollback

**User (post-deploy manual)**:
- [ ] Admin → Functions → paste trim-tool-history.py → Enable
- [ ] Admin → Settings → Interface → paste system-prompt-ops.md updated
- [ ] Delete chat "Kiểm Tra Host Mailer Shell" cũ (6.1MB) qua UI
- [ ] Test deep-trace chat mới, verify không hit ceiling

## Risks

1. **Gemini paid cost spike** nếu Filter/prompt cap fail → nhiều request đi qua Gemini Pro thay vì DeepSeek. Mitigation: monitor cost qua LiteLLM callback → VictoriaLogs, alert khi > $1/ngày.
2. **UX Warning gây phiền** nếu threshold quá thấp. Mitigation: threshold soft/hard 2 mức, user dismiss được, log stats để tune sau 1 tuần.
3. **VL `| limit 50` cắt data quan trọng**. Mitigation: system prompt cho phép user explicit override ("show 500 log") + LLM báo rõ đang cap.
4. **Gemini 2.5 Pro deprecation** (Google đã bắt đầu). Follow-up: khi Google GA 3.1-pro, migrate config.

## Success metrics

- **Deep-trace turn cap**: chat 30+ turn ops trace không hit ContextWindowExceededError trong 2 tuần
- **Cost**: Gemini paid < $10/tháng (verify qua LiteLLM cost callback)
- **False positive Warning**: < 20% user dismiss (đo qua Filter debug log)
- **User satisfaction**: hỏi phòng KT sau 2 tuần chạy prod

## Next steps

1. **User**: enable Google Cloud billing (5-10 phút)
2. **Ping lại session này** với message "Đã enable billing xong"
3. Tôi triển khai code + test + commit + deploy (~30 phút)
4. User install Filter + system prompt qua UI (~5 phút)
5. User verify deep-trace chat thực tế

## Unresolved

- Chưa test cost thực tế Gemini 2.5 Pro với traffic phòng KT (chỉ estimate). Cần monitor tuần đầu.
- Filter Function `__event_emitter__` API chưa verify OpenWebUI version hiện tại (v0.6+ có, cũ hơn không). Cần check `docker exec ragstack-openwebui python -c 'import open_webui; print(open_webui.__version__)'` khi implement.
- Nếu Gemini 2.5 Pro cost > kỳ vọng, có thể fallback về Option B (free aggressive) — không blocking decision hôm nay.
