import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertBffSecretReady,
  createChatServer,
  resolveUser,
} from "./web.js";
import { RuntimeReadiness } from "./runtime-readiness.js";

function request(headers: Record<string, string>): IncomingMessage {
  return {
    headers,
    method: "POST",
  } as IncomingMessage;
}

describe("chat web authentication boundary", () => {
  afterEach(() => {
    process.env.APP_ENV = "test";
    process.env.CHAT_BFF_SIGNING_SECRET =
      "test-bff-secret-0123456789abcdef";
  });

  it("allows the plaintext user header only in the explicit test environment", () => {
    delete process.env.CHAT_BFF_SIGNING_SECRET;
    process.env.APP_ENV = "test";

    expect(resolveUser(
      request({ "x-idream-user-id": "test-user" }),
      "{}",
      "/api/v1/chat/sessions",
    )).toEqual({ ok: true, userId: "test-user" });
  });

  it.each(["development", "preview", "production", undefined])(
    "rejects plaintext identity when APP_ENV is %s",
    (appEnv) => {
      delete process.env.CHAT_BFF_SIGNING_SECRET;
      if (appEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = appEnv;

      expect(resolveUser(
        request({ "x-idream-user-id": "forged-user" }),
        "{}",
        "/api/v1/chat/sessions",
      )).toEqual({ ok: false, reason: "missing_bff_secret" });
      expect(() => assertBffSecretReady()).toThrow(
        /CHAT_BFF_SIGNING_SECRET is required/,
      );
    },
  );

  it("rejects a message send without Idempotency-Key before dispatch", async () => {
    delete process.env.CHAT_BFF_SIGNING_SECRET;
    process.env.APP_ENV = "test";
    const readiness = new RuntimeReadiness();
    readiness.warmed();
    const server = createChatServer(readiness);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("chat test server did not expose a TCP address");
      }
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/chat/sessions/test-session/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idream-user-id": "test-user",
          },
          body: JSON.stringify({ content: "hello" }),
        },
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store, max-age=0",
      );
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("vary")).toContain("X-iDream-BFF-User");
      await expect(response.json()).resolves.toMatchObject({
        error: "idempotency_key_required",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("keeps liveness up while readiness gates business traffic", async () => {
    const readiness = new RuntimeReadiness();
    const server = createChatServer(readiness);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test address");
      const origin = `http://127.0.0.1:${address.port}`;
      expect((await fetch(`${origin}/healthz`)).status).toBe(200);
      expect((await fetch(`${origin}/readyz`)).status).toBe(503);
      expect((await fetch(`${origin}/api/v1/chat/sessions`)).status).toBe(503);
      readiness.warmed();
      expect((await fetch(`${origin}/readyz`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
