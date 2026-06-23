/**
 * Streaming POST → SSE parser.
 *
 * EventSource only does GET; we need POST so we hand-roll the parser.
 * Yields `{event, data}` objects as they arrive. The agent emits one event
 * per phase (thinking / tool_call / tool_result / answer / error).
 */
export type SSEEvent = { event: string; data: string };

export async function* streamSSE(
  url: string,
  body: unknown,
  signal?: AbortSignal,
  /** Called once with the Response before consuming the stream — handy for
   *  reading custom headers (X-Conversation-Id) without buffering the body. */
  onResponse?: (res: Response) => void,
): AsyncGenerator<SSEEvent> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`);
  }
  onResponse?.(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    // Normalize CRLF → LF up front — sse-starlette emits `\r\n` per spec
    // (browser EventSource handles both, but our manual split needs LF only).
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    // SSE delimits events with a blank line. We process complete events,
    // leaving any partial trailing event in the buffer for the next chunk.
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const block of parts) {
      const lines = block.split("\n");
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) yield { event: currentEvent, data };
    }
  }
}
