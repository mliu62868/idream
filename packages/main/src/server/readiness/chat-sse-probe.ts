type ChatSseObservation = {
  readonly fatalError: boolean;
  readonly lastEventId: string | null;
  readonly sawDelta: boolean;
  readonly sawDone: boolean;
  readonly sawStart: boolean;
};

export type ChatSseProbeResult = ChatSseObservation & {
  readonly ok: boolean;
  readonly reconnects: number;
  readonly status?: number;
  readonly error?: string;
};

type ChatSseProbeOptions = {
  readonly open: (lastEventId: string | null) => Promise<Response>;
  readonly timeoutMs: number;
  readonly reconnectDelayMs?: number;
};

// SPEC: A retryable Chat attempt error is not the terminal user result. The
// same assistant message can be retried by the reconciler, so readiness must
// reconnect with Last-Event-ID and prove the later delta/done sequence.
export async function observeChatSseAcrossReconnects(
  options: ChatSseProbeOptions,
): Promise<ChatSseProbeResult> {
  const deadline = Date.now() + options.timeoutMs;
  const reconnectDelayMs = options.reconnectDelayMs ?? 250;
  let reconnects = 0;
  let lastEventId: string | null = null;
  let sawStart = false;
  let sawDelta = false;
  let sawDone = false;

  while (Date.now() < deadline) {
    let response: Response;
    try {
      response = await options.open(lastEventId);
    } catch (error) {
      return result({
        ok: false,
        fatalError: false,
        lastEventId,
        reconnects,
        sawDelta,
        sawDone,
        sawStart,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!response.ok || !response.body) {
      return result({
        ok: false,
        fatalError: true,
        lastEventId,
        reconnects,
        sawDelta,
        sawDone,
        sawStart,
        status: response.status,
        error: `HTTP ${response.status}`,
      });
    }

    const text = await readResponseUntilClose(
      response,
      Math.max(1, deadline - Date.now()),
    );
    const observation = inspectChatSse(text);
    lastEventId = observation.lastEventId ?? lastEventId;
    sawStart ||= observation.sawStart;
    sawDelta ||= observation.sawDelta;
    sawDone ||= observation.sawDone;

    if (sawDone) {
      return result({
        ok: sawStart && sawDelta,
        fatalError: false,
        lastEventId,
        reconnects,
        sawDelta,
        sawDone,
        sawStart,
        status: response.status,
      });
    }
    if (observation.fatalError) {
      return result({
        ok: false,
        fatalError: true,
        lastEventId,
        reconnects,
        sawDelta,
        sawDone,
        sawStart,
        status: response.status,
      });
    }

    reconnects += 1;
    if (reconnectDelayMs > 0) await delay(reconnectDelayMs);
  }

  return result({
    ok: false,
    fatalError: false,
    lastEventId,
    reconnects,
    sawDelta,
    sawDone,
    sawStart,
    error: `chat SSE did not reach done within ${options.timeoutMs}ms`,
  });
}

function result(value: ChatSseProbeResult): ChatSseProbeResult {
  return value;
}

function inspectChatSse(text: string): ChatSseObservation {
  let fatalError = false;
  let lastEventId: string | null = null;
  let sawDelta = false;
  let sawDone = false;
  let sawStart = false;

  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim();
    if (id) lastEventId = id;
    const dataText = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    const payload = jsonRecord(dataText);
    const event =
      lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ??
      stringValue(payload.type);
    if (event === "start") sawStart = true;
    if (event === "delta") sawDelta = true;
    if (event === "done") sawDone = true;
    if (event === "error" && payload.retryable !== true) fatalError = true;
  }

  return { fatalError, lastEventId, sawDelta, sawDone, sawStart };
}

async function readResponseUntilClose(
  response: Response,
  timeoutMs: number,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<{ done: true; value: undefined }>((resolve) => {
        timer = setTimeout(
          () => resolve({ done: true, value: undefined }),
          Math.max(0, deadline - Date.now()),
        );
      });
      const chunk = await Promise.race([reader.read(), timeout]);
      if (timer) clearTimeout(timer);
      if (chunk.done) break;
      if (chunk.value) text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

function jsonRecord(value: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
