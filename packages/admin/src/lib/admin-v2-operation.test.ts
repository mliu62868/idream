import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_V2_API_OPERATIONS_BY_ID } from "@idream/shared/admin";
import { adminV2ContractFixtures } from "@idream/shared/admin/testing/contract-fixtures";
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
  const fetchMock = vi.fn(
    async (input: string | URL | Request, requestInit?: RequestInit) => {
      void input;
      void requestInit;
      return Response.json(payload, init);
    },
  );
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
        body: {
          entityVersion: 3,
          reason: { code: "other", summary: "pause" },
          confirmation: "PAUSE character 1",
        },
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
        body: { entityVersion: 3, reason: { code: "other", summary: "resume" }, confirmation: "RESUME" },
      }),
    ).rejects.toThrow();
  });

  it("attaches an idempotency key and the If-Match the manifest declares, without the caller naming either", async () => {
    const contract = ADMIN_V2_API_OPERATIONS_BY_ID["POST /api/v2/admin/characters/:id/releases"].contract.response;
    const fetchMock = stubFetch({ ok: true, data: adminV2ContractFixtures(contract).valid });

    await adminV2Operation("POST /api/v2/admin/characters/:id/releases", {
      path: { id: "character-1" },
      ifMatch: 7,
      body: {
        entityVersion: 7,
        reason: "Publish current draft",
        confirmation: "character-1:propose-release",
      },
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get("idempotency-key")).toMatch(/.{8,}/);
    expect(headers.get("if-match")).toBe('"7"');
  });

  // Acknowledged success ends an intent; identical later actions receive new keys.
  it("mints a new key after an acknowledged success, including identical later bodies", async () => {
    const fetchMock = stubFetch({ ok: true, data: ACCEPTED_COMMAND });
    const pause = (reason: string) =>
      adminV2Operation("POST /api/v2/admin/characters/:id/commands/pause", {
        path: { id: "character-key-reuse" },
        body: { entityVersion: 3, reason: { code: "other", summary: reason }, confirmation: "PAUSE" },
      });

    await pause("network flake");
    await pause("network flake");
    await pause("actually a policy hold");

    const keys = fetchMock.mock.calls.map(
      ([, init]) => new Headers(init?.headers).get("idempotency-key"),
    );
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("keeps the key across a retry when the response never arrived", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, requestInit?: RequestInit): Promise<Response> => {
        void input;
        void requestInit;
        throw new TypeError("Failed to fetch");
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const withdraw = () =>
      adminV2Operation("POST /api/v2/admin/characters/:id/commands/retire", {
        path: { id: "character-lost-response" },
        body: { entityVersion: 2, reason: { code: "other", summary: "retire" }, confirmation: "RETIRE" },
      });

    await expect(withdraw()).rejects.toThrow("Failed to fetch");
    await expect(withdraw()).rejects.toThrow("Failed to fetch");

    const keys = fetchMock.mock.calls.map(
      ([, init]) => new Headers(init?.headers).get("idempotency-key"),
    );
    expect(keys[1]).toBe(keys[0]);
  });

  it("appends a query string to the declared route", async () => {
    const contract = ADMIN_V2_API_OPERATIONS_BY_ID["GET /api/v2/admin/creative/runs"].contract.response;
    const fetchMock = stubFetch({ ok: true, data: adminV2ContractFixtures(contract).valid });

    await adminV2Operation("GET /api/v2/admin/creative/runs", {
      query: "targetType=character&limit=30",
    });

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
    const missingBody = () =>
      // @ts-expect-error - mutation body is required
      adminV2Operation("POST /api/v2/admin/characters/:id/commands/pause", { path: { id: "c" } });
    const invalidBody = () =>
      // @ts-expect-error - reason is structured, not a string
      adminV2Operation("POST /api/v2/admin/characters/:id/commands/pause", { path: { id: "c" }, body: { entityVersion: 1, reason: "pause", confirmation: "PAUSE" } });
    const bothBodyAndForm = () =>
      // @ts-expect-error - multipart and JSON are mutually exclusive
      adminV2Operation("POST /api/v2/admin/assets", { intent: "upload", form: new FormData(), body: {} });
    expect([undeclared, missingPathParameter, missingBody, invalidBody, bothBodyAndForm]).toHaveLength(5);
  });

  it("fails an operation and a v1 write with the same error class", async () => {
    stubFetch(
      {
        ok: false,
        error: { code: "conflict", message: "Character version changed" },
      },
      { status: 409 },
    );

    const operationError = await adminV2Operation(
      "POST /api/v2/admin/characters/:id/commands/retire",
      { path: { id: "character-1" }, body: { entityVersion: 2, reason: { code: "other", summary: "retire" }, confirmation: "RETIRE" } },
    ).catch((cause: unknown) => cause);
    const legacyError = await apiWrite(
      "/api/v2/admin/content/featured",
      "PUT",
      {},
    ).catch((cause: unknown) => cause);

    expect(operationError).toBeInstanceOf(AdminV2RequestError);
    expect(legacyError).toBeInstanceOf(AdminV2RequestError);
    expect((operationError as AdminV2RequestError).status).toBe(409);
    expect((legacyError as AdminV2RequestError).status).toBe(409);
  });
});
