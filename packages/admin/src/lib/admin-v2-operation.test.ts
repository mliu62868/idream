import { afterEach, describe, expect, it, vi } from "vitest";
import { apiWrite } from "@/components/admin/api";
import { AdminV2RequestError } from "./admin-v2-api";
import { adminV2Operation } from "./admin-v2-operation";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ACCEPTED_COMMAND = {
  status: "accepted",
  requestId: "request-1",
  commandId: "command-1",
  verificationDeepLink: "/admin/characters/character-1?tab=release",
};

function stubFetch(payload: unknown, init?: ResponseInit) {
  const fetchMock = vi.fn(async (input: string | URL | Request, requestInit?: RequestInit) => {
    void input;
    void requestInit;
    return Response.json(payload, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("admin v2 operation adapter", () => {
  it("derives method, route and response contract from the operation id", async () => {
    const fetchMock = stubFetch({ ok: true, data: ACCEPTED_COMMAND });

    const accepted = await adminV2Operation(
      "POST /api/v2/admin/characters/:id/commands/pause",
      {
        path: { id: "character 1" },
        idempotencyKey: "pause-1",
        body: { entityVersion: 3, reason: "pause", confirmation: "PAUSE character 1" },
      },
    );

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v2/admin/characters/character%201/commands/pause");
    expect(init?.method).toBe("POST");
    expect(accepted.commandId).toBe("command-1");
  });

  it("rejects a payload the declared response contract does not accept", async () => {
    stubFetch({ ok: true, data: { ...ACCEPTED_COMMAND, status: "completed" } });

    await expect(
      adminV2Operation("POST /api/v2/admin/characters/:id/commands/resume", {
        path: { id: "character-1" },
        idempotencyKey: "resume-1",
        body: {},
      }),
    ).rejects.toThrow();
  });

  it("forwards the idempotency key and If-Match the manifest declares", async () => {
    const fetchMock = stubFetch({
      ok: true,
      data: {
        runId: "qa-run-1",
        characterId: "character-1",
        status: "passed",
        checks: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        actorId: "operator-1",
      },
    });

    await adminV2Operation("POST /api/v2/admin/characters/:id/qa-runs", {
      path: { id: "character-1" },
      idempotencyKey: "qa-1",
      ifMatch: 7,
      body: { entityVersion: 7, checks: [], reason: "QA" },
    }).catch(() => undefined);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get("idempotency-key")).toBe("qa-1");
    expect(headers.get("if-match")).toBe('"7"');
  });

  it("appends a query string to the declared route", async () => {
    const fetchMock = stubFetch({
      ok: true,
      data: { items: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });

    await adminV2Operation("GET /api/v2/admin/creative/runs", {
      query: "targetType=character&limit=30",
    }).catch(() => undefined);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v2/admin/creative/runs?targetType=character&limit=30",
    );
  });

  it("makes an undeclared operation id and a missing path parameter compile errors", () => {
    // INTENT: 这两条断言只在编译期有意义 —— 运行时什么都不做，`@ts-expect-error` 一旦
    //         多余，tsc 自己会报错，等于把「配错就编译不过」这条保证钉在测试里。
    const undeclared = () =>
      // @ts-expect-error - 不在 manifest 里的 operation id
      adminV2Operation("GET /api/v2/admin/not-an-operation", {});
    const missingPathParameter = () =>
      // @ts-expect-error - 路由模板声明了 :id
      adminV2Operation("GET /api/v2/admin/characters/:id", {});
    expect([undeclared, missingPathParameter]).toHaveLength(2);
  });

  it("fails an operation and a v1 write with the same error class", async () => {
    stubFetch(
      { ok: false, error: { code: "conflict", message: "Character version changed" } },
      { status: 409 },
    );

    const operationError = await adminV2Operation(
      "POST /api/v2/admin/characters/:id/commands/retire",
      { path: { id: "character-1" }, idempotencyKey: "retire-1", body: {} },
    ).catch((cause: unknown) => cause);
    const legacyError = await apiWrite("/api/v2/admin/content/featured", "PUT", {})
      .catch((cause: unknown) => cause);

    expect(operationError).toBeInstanceOf(AdminV2RequestError);
    expect(legacyError).toBeInstanceOf(AdminV2RequestError);
    expect((operationError as AdminV2RequestError).status).toBe(409);
    expect((legacyError as AdminV2RequestError).status).toBe(409);
  });
});
