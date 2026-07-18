// BFF proxy: signs an internal user context and forwards to the chat service.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyBffContext, type BffContext } from "@idream/shared/bff";

const SECRET = "test-bff-secret-0123456789abcdef";

function expectPrivateNoStore(response: Response) {
  expect(response.headers.get("cache-control")).toBe(
    "private, no-store, max-age=0",
  );
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("vary")).toContain("Cookie");
  expect(response.headers.get("vary")).toContain("Authorization");
}

describe("proxyChatRequest", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.ADMIN_BFF_SIGNING_SECRET =
      "test-admin-bff-secret-0123456789abcdef";
    process.env.APP_ENV = "test";
    process.env.BETTER_AUTH_URL = "https://idream.test";
    process.env.MAIN_WEB_URL = "https://idream.test";
    process.env.CHAT_SERVICE_URL = "http://chat.internal";
    process.env.CHAT_BFF_SIGNING_SECRET = SECRET;
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ADMIN_BFF_SIGNING_SECRET;
    delete process.env.CHAT_SERVICE_URL;
    delete process.env.CHAT_BFF_SIGNING_SECRET;
    delete process.env.BETTER_AUTH_URL;
    delete process.env.MAIN_WEB_URL;
    process.env.APP_ENV = "test";
    // env is parsed at import; reset so each test re-reads the env beforeEach sets.
    vi.resetModules();
  });

  it("forwards with a verifiable HMAC signature and no cookie", async () => {
    // import lazily so env is read fresh per test
    const { proxyChatRequest } = await import("./chat-proxy");
    const body = JSON.stringify({ characterId: "c1" });
    const req = new Request("http://localhost:3000/api/v1/chat/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session=secret",
        "x-idream-bff": "forged-signature",
        "x-idream-bff-user": JSON.stringify({ userId: "forged-user" }),
        "x-idream-role": "admin",
        "x-idream-user-id": "seed-dev-user",
      },
      body,
    });

    const res = await proxyChatRequest(req, ["chat", "sessions"]);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    expect(url).toBe("http://chat.internal/api/v1/chat/sessions");
    const headers = init.headers as Headers;
    // cookie must NOT cross the trust boundary
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-idream-role")).toBeNull();
    expect(headers.get("x-idream-user-id")).toBeNull();

    const signature = headers.get("x-idream-bff");
    const ctxRaw = headers.get("x-idream-bff-user");
    expect(signature).toBeTruthy();
    const context = JSON.parse(ctxRaw as string) as BffContext;
    expect(context.userId).toBe("seed-dev-user");

    const verdict = verifyBffContext({
      secret: SECRET,
      signature: signature as string,
      context,
      method: "POST",
      path: "/api/v1/chat/sessions",
      body,
      now: Date.now(),
    });
    expect(verdict.ok).toBe(true);
  });

  it("uses plaintext user context only in the explicit test environment", async () => {
    delete process.env.CHAT_BFF_SIGNING_SECRET;
    vi.resetModules();
    const { proxyChatRequest } = await import("./chat-proxy");
    const req = new Request("http://localhost/api/v1/chat/sessions", {
      method: "GET",
      headers: {
        "x-idream-bff": "forged-signature",
        "x-idream-bff-user": JSON.stringify({ userId: "forged-user" }),
        "x-idream-role": "admin",
        "x-idream-user-id": "seed-dev-user",
      },
    });

    const res = await proxyChatRequest(req, ["chat", "sessions"]);
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Headers },
    ];
    const headers = init.headers as Headers;
    expect(headers.get("x-idream-user-id")).toBe("seed-dev-user");
    expect(headers.get("x-idream-role")).toBeNull();
    expect(headers.get("x-idream-bff")).toBeNull();
    expect(headers.get("x-idream-bff-user")).toBeNull();
  });

  it.each(["development", "preview", "production"])(
    "fails closed when the signing secret is missing in %s",
    async (appEnv) => {
      process.env.APP_ENV = appEnv;
      delete process.env.CHAT_BFF_SIGNING_SECRET;
      vi.resetModules();
      const { proxyChatRequest } = await import("./chat-proxy");
      const req = new Request("http://localhost/api/v1/chat/sessions", {
        method: "GET",
        headers: { "x-idream-user-id": "seed-dev-user" },
      });

      const res = await proxyChatRequest(req, ["chat", "sessions"]);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        error: "chat_unavailable",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("401 when unauthenticated", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const req = new Request("http://localhost:3000/api/v1/chat/sessions", { method: "GET" });
    const res = await proxyChatRequest(req, ["chat", "sessions"]);
    expect(res.status).toBe(401);
    expectPrivateNoStore(res);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const jsonResp = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const authedHeaders = { "content-type": "application/json", "x-idream-user-id": "seed-dev-user" };

  it("adapts POST /chat/sessions → { ok, data: { session } }", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    fetchMock.mockResolvedValueOnce(jsonResp({ id: "sess_1", characterId: "c1" }, 201));
    const req = new Request("http://localhost/api/v1/chat/sessions", {
      method: "POST",
      headers: authedHeaders,
      body: JSON.stringify({ characterId: "c1" }),
    });
    const res = await proxyChatRequest(req, ["chat", "sessions"]);
    expect(res.status).toBe(201);
    expectPrivateNoStore(res);
    expect(await res.json()).toEqual({ ok: true, data: { session: { id: "sess_1", characterId: "c1" } } });
  });

  it("adapts POST messages → echoes user content + assistant placeholder + streamUrl", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const idempotencyKey = "chat-send-test-key-0001";
    fetchMock.mockResolvedValueOnce(
      jsonResp(
        { userMessageId: "mu", assistantMessageId: "ma", streamUrl: "/api/v1/chat/messages/ma/stream", status: "generating" },
        202,
      ),
    );
    const req = new Request("http://localhost/api/v1/chat/sessions/s1/messages", {
      method: "POST",
      headers: { ...authedHeaders, "idempotency-key": idempotencyKey },
      body: JSON.stringify({ content: "  hi there  " }),
    });
    const res = await proxyChatRequest(req, ["chat", "sessions", "s1", "messages"]);
    const [, init] = fetchMock.mock.calls.at(-1) as [
      string,
      RequestInit & { headers: Headers },
    ];
    expect(init.headers.get("idempotency-key")).toBe(idempotencyKey);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data.userMessage).toEqual({ id: "mu", role: "user", content: "hi there" });
    expect(json.data.assistant).toEqual({ id: "ma", role: "assistant", content: "", status: "generating" });
    expect(json.data.streamUrl).toBe("/api/v1/chat/messages/ma/stream");
  });

  it("adapts a BLOCKED send → status blocked, null streamUrl, safety notice (P0-B)", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    fetchMock.mockResolvedValueOnce(
      jsonResp(
        {
          userMessageId: "mu",
          assistantMessageId: "ma",
          streamUrl: null,
          status: "blocked",
          safety: { layer: "input", policyCode: "age_under_18" },
        },
        202,
      ),
    );
    const req = new Request("http://localhost/api/v1/chat/sessions/s1/messages", {
      method: "POST",
      headers: authedHeaders,
      body: JSON.stringify({ content: "blocked content" }),
    });
    const res = await proxyChatRequest(req, ["chat", "sessions", "s1", "messages"]);
    const json = (await res.json()) as {
      data: { assistant: { status: string; content: string }; streamUrl: unknown; safety?: { layer: string } };
    };
    expect(json.data.assistant.status).toBe("blocked");
    expect(json.data.assistant.content).toContain("can");
    expect(json.data.streamUrl).toBeNull();
    expect(json.data.safety?.layer).toBe("input");
  });

  it("returns a structured 503 chat_unavailable when CHAT_SERVICE_URL is unset (P0-A)", async () => {
    // env is parsed at import, so unset BEFORE a fresh module load.
    delete process.env.CHAT_SERVICE_URL;
    vi.resetModules();
    const { proxyChatRequest } = await import("./chat-proxy");
    const req = new Request("http://localhost/api/v1/chat/sessions", {
      method: "GET",
      headers: { "x-idream-user-id": "seed-dev-user" },
    });
    const res = await proxyChatRequest(req, ["chat", "sessions"]);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("chat_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adapts GET session → embeds messages + character name", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const db = await import("@/server/lib/db");
    const spy = vi
      .spyOn(db.prisma.character, "findUnique")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValue({ name: "Mei" } as any);
    fetchMock.mockResolvedValueOnce(
      jsonResp(
        { session: { id: "s1", title: null, characterId: "c1" }, messages: [{ id: "m1", role: "user", content: "hi" }] },
        200,
      ),
    );
    const req = new Request("http://localhost/api/v1/chat/sessions/s1", {
      method: "GET",
      headers: { "x-idream-user-id": "seed-dev-user" },
    });
    const res = await proxyChatRequest(req, ["chat", "sessions", "s1"]);
    const json = (await res.json()) as {
      data: { session: { id: string; character: { name: string }; messages: unknown[] } };
    };
    expect(json.data.session.id).toBe("s1");
    expect(json.data.session.character.name).toBe("Mei");
    expect(json.data.session.messages).toHaveLength(1);
    spy.mockRestore();
  });

  it("keeps owner legacy test media visible with explicit synthetic authority", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const db = await import("@/server/lib/db");
    const characterSpy = vi
      .spyOn(db.prisma.character, "findUnique")
      .mockResolvedValue({
        creatorId: "seed-dev-user",
        name: "Mei",
      } as never);
    const mediaSpy = vi
      .spyOn(db.prisma.mediaAsset, "findMany")
      .mockResolvedValue([
        {
          height: 640,
          id: "asset_legacy",
          metadata: { synthetic: true, source: "mock" },
          thumbnailUrl: null,
          url: "/user-content/legacy.webp",
          width: 512,
        },
      ] as never);
    fetchMock.mockResolvedValueOnce(
      jsonResp(
        {
          session: { id: "s1", title: null, characterId: "c1" },
          messages: [{
            id: "m1",
            role: "assistant",
            content: "",
            attachments: [{
              id: "attachment_1",
              kind: "image",
              mediaAssetId: "asset_legacy",
              status: "completed",
            }],
          }],
        },
        200,
      ),
    );
    const req = new Request("http://localhost/api/v1/chat/sessions/s1", {
      method: "GET",
      headers: { "x-idream-user-id": "seed-dev-user" },
    });

    const res = await proxyChatRequest(req, ["chat", "sessions", "s1"]);
    const json = (await res.json()) as {
      data: {
        session: {
          messages: Array<{
            attachments: Array<Record<string, unknown>>;
          }>;
        };
      };
    };

    expect(json.data.session.messages[0]?.attachments[0]).toMatchObject({
      isSynthetic: true,
      mediaUrl: "/user-content/legacy.webp",
    });
    expect(mediaSpy).toHaveBeenCalledOnce();
    mediaSpy.mockRestore();
    characterSpy.mockRestore();
  });

  it("passes through management endpoints (memories) unchanged", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    fetchMock.mockResolvedValueOnce(jsonResp({ memories: [{ id: "mem_1" }] }, 200));
    const req = new Request("http://localhost/api/v1/chat/memories", {
      method: "GET",
      headers: { "x-idream-user-id": "seed-dev-user" },
    });
    const res = await proxyChatRequest(req, ["chat", "memories"]);
    expectPrivateNoStore(res);
    expect(await res.json()).toEqual({ memories: [{ id: "mem_1" }] });
  });
});
