import { createServer, type Server, type Socket } from "node:net";
import type IORedis from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({ clients: [] as IORedis[] }));
vi.mock("ioredis", async importOriginal => {
  const { default: Redis } = await importOriginal<typeof import("ioredis")>();
  return {
    default: class extends Redis {
      constructor(options: import("ioredis").RedisOptions) {
        super(options);
        observed.clients.push(this);
        this.on("error", () => undefined);
      }
    },
  };
});

import { appendStreamEvent, closeStreamPublisher, createSseResponse } from "./stream.js";

describe("Chat Redis transport deadlines", () => {
  let server: Server;
  let sockets: Set<Socket>;

  beforeEach(async () => {
    sockets = new Set();
    // Accept TCP but never answer Redis commands. A retry cap alone cannot
    // detect this failure because the connection never disconnects.
    server = createServer(socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture port");
    vi.stubEnv("CHAT_REDIS_URL", `redis://127.0.0.1:${address.port}/14`);
  });

  afterEach(async () => {
    for (const client of observed.clients.splice(0)) client.disconnect();
    for (const socket of sockets) socket.destroy();
    await closeStreamPublisher().catch(() => undefined);
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  it("rejects publication when Redis accepts a connection but stops responding", async () => {
    await expect(appendStreamEvent("chat:stream:blackhole", {
      type: "start", attempt: 1,
    })).rejects.toThrow(/Command timed out/iu);
  }, 8_000);

  it("ends the SSE read when the Redis tailer stops responding", async () => {
    const response = createSseResponse("chat:stream:blackhole", null, 1);
    const reader = response.body!.getReader();
    const connected = await reader.read();
    expect(new TextDecoder().decode(connected.value)).toBe(": connected\n\n");
    await expect(reader.read()).rejects.toThrow(/Command timed out/iu);
  }, 8_000);
});
