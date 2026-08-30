import { describe, expect, it } from "vitest";
import { observeChatSseAcrossReconnects } from "./chat-sse-probe";

function response(body: string) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("chat SSE readiness probe", () => {
  it("reconnects after transport closure and resumes with Last-Event-ID", async () => {
    const connections = [
      response([
        "id: 1-0",
        "event: start",
        'data: {"type":"start","attempt":1}',
        "",
      ].join("\n")),
      response([
        "id: 2-0",
        "event: delta",
        'data: {"type":"delta","attempt":1,"seq":1,"delta":"ready"}',
        "",
        "id: 3-0",
        "event: done",
        'data: {"type":"done","attempt":1,"usage":{}}',
        "",
      ].join("\n")),
    ];
    const cursors: Array<string | null> = [];

    const result = await observeChatSseAcrossReconnects({
      timeoutMs: 1_000,
      reconnectDelayMs: 0,
      open: async (lastEventId) => {
        cursors.push(lastEventId);
        return connections.shift()!;
      },
    });

    expect(result).toMatchObject({
      ok: true,
      sawStart: true,
      sawDelta: true,
      sawDone: true,
      reconnects: 1,
      lastEventId: "3-0",
    });
    expect(cursors).toEqual([null, "1-0"]);
  });

  it("does not retry a terminal stream error", async () => {
    let connections = 0;
    const result = await observeChatSseAcrossReconnects({
      timeoutMs: 1_000,
      reconnectDelayMs: 0,
      open: async () => {
        connections += 1;
        return response([
          "id: 1-0",
          "event: error",
          'data: {"type":"error","code":"blocked","retryable":false}',
          "",
        ].join("\n"));
      },
    });

    expect(result).toMatchObject({
      ok: false,
      fatalError: true,
      reconnects: 0,
      error: "blocked",
    });
    expect(connections).toBe(1);
  });

  it("never accepts an older regeneration attempt as the requested terminal", async () => {
    const result = await observeChatSseAcrossReconnects({
      expectedAttempt: 2,
      timeoutMs: 1_000,
      reconnectDelayMs: 0,
      open: async () => response([
        "id: 1-0",
        "event: start",
        'data: {"type":"start","attempt":1}',
        "",
        "id: 2-0",
        "event: delta",
        'data: {"type":"delta","attempt":1,"seq":1,"delta":"old"}',
        "",
        "id: 3-0",
        "event: done",
        'data: {"type":"done","attempt":1,"usage":{}}',
        "",
        "id: 4-0",
        "event: error",
        'data: {"type":"error","attempt":2,"code":"provider_failed","retryable":false}',
        "",
      ].join("\n")),
    });

    expect(result).toMatchObject({
      ok: false,
      fatalError: true,
      sawStart: false,
      sawDelta: false,
      sawDone: false,
      lastEventId: "4-0",
      error: "provider_failed",
    });
  });

  it("treats legacy retryable error metadata as a terminal attempt", async () => {
    const result = await observeChatSseAcrossReconnects({
      timeoutMs: 1_000,
      reconnectDelayMs: 0,
      open: async () => response([
        "event: error",
        'data: {"type":"error","code":"provider_failed","retryable":true}',
        "",
      ].join("\n")),
    });

    expect(result).toMatchObject({
      ok: false,
      fatalError: true,
      reconnects: 0,
      error: "provider_failed",
    });
  });
});
