import { describe, expect, it } from "vitest";
import { observeChatSseAcrossReconnects } from "./chat-sse-probe";

function response(body: string) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("chat SSE readiness probe", () => {
  it("follows a retryable provider failure into the successful retry", async () => {
    const connections = [
      response([
        "id: 1-0",
        "event: start",
        'data: {"type":"start","attempt":1}',
        "",
        "id: 2-0",
        "event: error",
        'data: {"type":"error","attempt":1,"code":"provider_failed","retryable":true}',
        "",
      ].join("\n")),
      response([
        "id: 3-0",
        "event: start",
        'data: {"type":"start","attempt":2}',
        "",
        "id: 4-0",
        "event: delta",
        'data: {"type":"delta","attempt":2,"seq":1,"delta":"ready"}',
        "",
        "id: 5-0",
        "event: done",
        'data: {"type":"done","attempt":2,"usage":{}}',
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
      lastEventId: "5-0",
    });
    expect(cursors).toEqual([null, "2-0"]);
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

    expect(result).toMatchObject({ ok: false, fatalError: true, reconnects: 0 });
    expect(connections).toBe(1);
  });
});
