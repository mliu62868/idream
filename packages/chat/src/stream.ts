// SPEC: Chat token stream over a Redis Stream (design §4). Producer XADDs with
// MAXLEN cap; consumer reads with XREAD BLOCK from Last-Event-ID for resumable
// SSE (replaces the old 150ms poll). On expiry the client falls back to GET
// /sessions/:id (already-persisted messages).
// INVARIANTS: terminal event (done|error) closes the stream; stream is capped.
import IORedis from "ioredis";
import { chatStreamEventSchema, type ChatStreamEvent } from "@idream/shared/contracts";
import { env } from "./env.js";

const STREAM_MAXLEN = 1000;
const SSE_DEADLINE_MS = 60_000;
const BLOCK_MS = 5_000;

function createRedis(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

// SPEC: ONE shared publisher for the non-blocking stream ops (XADD/XRANGE).
// appendStreamEvent runs once per model delta — hundreds per reply — so a
// connect/AUTH/quit cycle per call would swamp Redis. The blocking SSE tailer
// (createSseResponse, XREAD BLOCK) keeps its OWN connection: a blocking read must
// never share a client with the publisher.
let publisher: IORedis | null = null;
function publisherRedis(): IORedis {
  publisher ??= createRedis();
  return publisher;
}

/** Close the shared publisher (graceful shutdown / test reset). */
export async function closeStreamPublisher(): Promise<void> {
  const current = publisher;
  if (!current) return;
  publisher = null;
  await current.quit();
}

export function streamKey(assistantMessageId: string): string {
  return `chat:stream:${assistantMessageId}`;
}

export interface StoredStreamEvent {
  id: string;
  event: ChatStreamEvent;
}

export async function appendStreamEvent(
  key: string,
  event: ChatStreamEvent,
): Promise<StoredStreamEvent> {
  const parsed = chatStreamEventSchema.parse(event);
  const id = await publisherRedis().xadd(
    key, "MAXLEN", "~", String(STREAM_MAXLEN), "*", "data", JSON.stringify(parsed),
  );
  return { id: id ?? "", event: parsed };
}

export async function listStreamEvents(key: string, afterId?: string | null): Promise<StoredStreamEvent[]> {
  const min = afterId ? `(${afterId}` : "-";
  const rows = (await publisherRedis().xrange(key, min, "+")) as Array<[string, string[]]>;
  return rows.flatMap(parseRow);
}

/** SSE Response that tails the stream with XREAD BLOCK from lastEventId. */
export function createSseResponse(key: string, lastEventId?: string | null): Response {
  const encoder = new TextEncoder();
  const redis = createRedis();
  let closed = false;
  let cursor = lastEventId && lastEventId.length > 0 ? lastEventId : "0";

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      const deadline = Date.now() + SSE_DEADLINE_MS;
      try {
        while (!closed && Date.now() < deadline) {
          // XREAD BLOCK waits for new entries without busy-polling.
          const res = (await redis.xread("BLOCK", BLOCK_MS, "STREAMS", key, cursor)) as
            | Array<[string, Array<[string, string[]]>]>
            | null;
          if (!res) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
            continue;
          }
          for (const [, entries] of res) {
            for (const row of entries) {
              const stored = parseRow(row);
              for (const s of stored) {
                cursor = s.id;
                controller.enqueue(encoder.encode(formatSse(s)));
                if (s.event.type === "done" || s.event.type === "error") {
                  closed = true;
                }
              }
            }
          }
        }
      } finally {
        await redis.quit();
        controller.close();
      }
    },
    async cancel() {
      closed = true;
      await redis.quit();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function parseRow(row: [string, string[]]): StoredStreamEvent[] {
  const [id, fields] = row;
  const idx = fields.findIndex((f) => f === "data");
  const data = idx >= 0 ? fields[idx + 1] : undefined;
  if (!data) return [];
  return [{ id, event: chatStreamEventSchema.parse(JSON.parse(data) as unknown) }];
}

function formatSse(stored: StoredStreamEvent): string {
  return [
    `id: ${stored.id}`,
    `event: ${stored.event.type}`,
    `data: ${JSON.stringify(stored.event)}`,
    "",
    "",
  ].join("\n");
}
