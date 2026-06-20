// BFF proxy: signs an internal user context and forwards to the chat service.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyBffContext, type BffContext } from "@idream/shared/bff";

const SECRET = "test-bff-secret-0123456789abcdef";

describe("proxyChatRequest", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.CHAT_SERVICE_URL = "http://chat.internal";
    process.env.CHAT_BFF_SIGNING_SECRET = SECRET;
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CHAT_SERVICE_URL;
    delete process.env.CHAT_BFF_SIGNING_SECRET;
  });

  it("forwards with a verifiable HMAC signature and no cookie", async () => {
    // import lazily so env is read fresh per test
    const { proxyChatRequest } = await import("./chat-proxy");
    const body = JSON.stringify({ characterId: "c1" });
    const req = new Request("http://localhost:3000/api/v1/chat/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session=secret", "x-idream-user-id": "seed-dev-user" },
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

  it("401 when unauthenticated", async () => {
    const { proxyChatRequest } = await import("./chat-proxy");
    const req = new Request("http://localhost:3000/api/v1/chat/sessions", { method: "GET" });
    const res = await proxyChatRequest(req, ["chat", "sessions"]);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
