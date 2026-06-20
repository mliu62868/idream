import IORedis from "ioredis";
import { chatStreamEventSchema, type ChatStreamEvent } from "./schemas";
import { env } from "@/server/lib/env";

export interface StoredChatStreamEvent {
  id: string;
  event: ChatStreamEvent;
}

type RedisStreamRow = [string, string[]];

export async function appendChatStreamEvent(streamKey: string, event: ChatStreamEvent) {
  const parsed = chatStreamEventSchema.parse(event);
  const redis = createRedis();
  try {
    const id = await redis.xadd(
      streamKey,
      "MAXLEN",
      "~",
      "1000",
      "*",
      "data",
      JSON.stringify(parsed),
    );
    return { id, event: parsed };
  } finally {
    await redis.quit();
  }
}

export async function listChatStreamEvents(streamKey: string, afterId?: string | null) {
  const redis = createRedis();
  try {
    const min = afterId ? `(${afterId}` : "-";
    const rows = (await redis.xrange(streamKey, min, "+")) as RedisStreamRow[];
    return rows.flatMap(parseStreamRow);
  } finally {
    await redis.quit();
  }
}

export function createChatSseResponse(streamKey: string, lastEventId?: string | null) {
  const encoder = new TextEncoder();
  let closed = false;
  let cursor = lastEventId ?? null;
  const redis = createRedis();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      const expiresAt = Date.now() + 30_000;

      try {
        while (!closed && Date.now() < expiresAt) {
          const min = cursor ? `(${cursor}` : "-";
          const rows = (await redis.xrange(streamKey, min, "+")) as RedisStreamRow[];
          const events = rows.flatMap(parseStreamRow);
          for (const stored of events) {
            cursor = stored.id;
            controller.enqueue(encoder.encode(formatSse(stored)));
            if (stored.event.type === "done" || stored.event.type === "error") {
              closed = true;
              break;
            }
          }

          if (!closed) await sleep(150);
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

function createRedis() {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

function parseStreamRow(row: RedisStreamRow): StoredChatStreamEvent[] {
  const [id, fields] = row;
  const dataIndex = fields.findIndex((field) => field === "data");
  const data = dataIndex >= 0 ? fields[dataIndex + 1] : undefined;
  if (!data) return [];
  return [{ id, event: chatStreamEventSchema.parse(JSON.parse(data) as unknown) }];
}

function formatSse(stored: StoredChatStreamEvent) {
  return [
    `id: ${stored.id}`,
    `event: ${stored.event.type}`,
    `data: ${JSON.stringify(stored.event)}`,
    "",
    "",
  ].join("\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
