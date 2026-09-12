import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

type CommandWhere = {
  readonly scope_idempotencyKey: { readonly scope: string; readonly idempotencyKey: string };
};
type CommandRow = {
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly result: unknown;
};

// SPEC: 一个只记账的 Prisma 替身——事务回滚就是「暂存的写入不合并进已提交的表」。
// INTENT: 这个用例要证的是「响应契约在哪个时刻校验」，不是 PostgreSQL 的隔离级别。替身让它
// 留在纯测试里：没有数据库也能断言「校验失败时 controlPlaneCommand 一行都没写」。
const db = vi.hoisted(() => {
  const committedCommands = new Map<string, CommandRow>();
  const committedCaseWrites: unknown[] = [];
  const key = (where: CommandWhere) =>
    `${where.scope_idempotencyKey.scope}|${where.scope_idempotencyKey.idempotencyKey}`;

  const transactionClient = (
    stagedCommands: Map<string, CommandRow>,
    stagedCaseWrites: unknown[],
  ) => ({
    $executeRaw: async () => 1,
    controlPlaneCommand: {
      findUnique: async ({ where }: { where: CommandWhere }) =>
        stagedCommands.get(key(where)) ?? committedCommands.get(key(where)) ?? null,
      create: async ({ data }: { data: CommandRow }) => {
        stagedCommands.set(`${data.scope}|${data.idempotencyKey}`, data);
        return data;
      },
    },
    adminCase: {
      update: async ({ data }: { data: unknown }) => {
        stagedCaseWrites.push(data);
        return data;
      },
    },
  });

  const prisma = {
    controlPlaneCommand: {
      findUnique: async ({ where }: { where: CommandWhere }) =>
        committedCommands.get(key(where)) ?? null,
    },
    $transaction: async (run: (tx: ReturnType<typeof transactionClient>) => Promise<unknown>) => {
      const stagedCommands = new Map<string, CommandRow>();
      const stagedCaseWrites: unknown[] = [];
      const result = await run(transactionClient(stagedCommands, stagedCaseWrites));
      for (const [entry, row] of stagedCommands) committedCommands.set(entry, row);
      committedCaseWrites.push(...stagedCaseWrites);
      return result;
    },
  };

  return {
    prisma,
    committedCommands,
    committedCaseWrites,
    reset() {
      committedCommands.clear();
      committedCaseWrites.length = 0;
    },
  };
});

const actor = { id: "adm_response_contract", role: "admin" as const };

vi.mock("@/server/lib/db", () => ({ prisma: db.prisma }));
vi.mock("./authority", () => ({
  authenticatedAdminActor: async () => actor,
  requireActorPermission: async () => actor,
  jsonBody: async (request: Request) => request.json(),
}));

const { executeAdminMutation, requireAdminMutationOperation } = await import("./admin-mutation");

const CASE_ID = "case_response_contract";
const decisionBody = {
  entityVersion: 3,
  decision: "actioned",
  summary: "Removed the reported asset",
  evidenceRefs: ["evidence_1"],
};

function decisionRequest(idempotencyKey: string) {
  return new Request(`http://admin.test/api/v2/admin/cases/${CASE_ID}/decisions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-request-id": "req_response_contract",
    },
    body: JSON.stringify(decisionBody),
  });
}

function recordDecision(
  request: Request,
  mutate: (tx: Prisma.TransactionClient) => Promise<unknown>,
) {
  return executeAdminMutation<typeof decisionBody>(
    "POST /api/v2/admin/cases/:id/decisions",
    request,
    {
      params: { id: CASE_ID },
      target: () => ({ type: "admin_case", id: CASE_ID }),
      expectedVersion: (body) => body.entityVersion,
      mutate: (tx) => mutate(tx),
    },
  );
}

/** 契约要的投影：caseId / status / verificationState / version，`.strict()`。 */
const contractResult = {
  caseId: CASE_ID,
  status: "resolved",
  verificationState: "passed",
  version: 4,
};

/** 事故里 service 直接 return 的 Prisma 行：列名不同，多余列被 `.strict()` 拒绝。 */
const prismaRow = {
  id: CASE_ID,
  status: "resolved",
  verificationState: "passed",
  version: 4,
  createdAt: "2026-09-11T00:00:00.000Z",
};

describe("Admin manifest-backed mutation execution", () => {
  it("resolves executable contracts and reliability metadata from one operation definition", () => {
    const definition = requireAdminMutationOperation(
      "PATCH /api/v2/admin/characters/:id/draft-image",
    );

    expect(definition.operation.mutation).toEqual({
      transport: "idempotency_key_and_if_match",
      commandType: "character.project.draft_image.select",
      executionMode: "atomic",
    });
    expect(definition.request.fixtureKey).toBe(
      "characterDraftImageSelectionRequestSchema",
    );
    expect(definition.request.requirements).toEqual([
      "idempotency-key",
      "if-match",
    ]);
    expect(definition.response.fixtureKey).toBe(
      "characterDraftImageSelectionResultSchema",
    );
  });

  it("fails closed for an unknown or read-only operation", () => {
    expect(() => requireAdminMutationOperation(
      "PATCH /api/v2/admin/characters/:id/unknown",
    )).toThrow("Unknown Admin mutation operation");
    expect(() => requireAdminMutationOperation(
      "GET /api/v2/admin/characters/:id",
    )).toThrow("not a mutation");
  });

  it("refuses a durable command, which only the control-plane handler may accept", () => {
    expect(() => requireAdminMutationOperation(
      "POST /api/v2/admin/cases/:id/commands/close",
    )).toThrow("control-plane handler");
  });
});

describe("Admin mutation response contract timing", () => {
  beforeEach(() => {
    db.reset();
  });

  it("rolls back the write when the domain result cannot satisfy the response contract", async () => {
    await expect(
      recordDecision(decisionRequest("idem-poison"), async (tx) => {
        await tx.adminCase.update({ where: { id: CASE_ID }, data: { status: "resolved" } });
        return prismaRow;
      }),
    ).rejects.toThrow();

    // 校验发生在事务内：领域写入和幂等记账一起回滚，没有留下垃圾行。
    expect(db.committedCommands.size).toBe(0);
    expect(db.committedCaseWrites).toEqual([]);
  });

  it("does not poison the idempotency key, so the corrected retry succeeds", async () => {
    await expect(
      recordDecision(decisionRequest("idem-retry"), async () => prismaRow),
    ).rejects.toThrow();

    const retried = await recordDecision(
      decisionRequest("idem-retry"),
      async () => contractResult,
    );

    expect(retried).toEqual(contractResult);
    expect(db.committedCommands.size).toBe(1);
  });

  it("stores and replays only a result the response contract accepts", async () => {
    const first = await recordDecision(
      decisionRequest("idem-replay"),
      async () => contractResult,
    );
    const replay = await recordDecision(decisionRequest("idem-replay"), async () => {
      throw new Error("replay must not re-run the domain mutation");
    });

    expect(first).toEqual(contractResult);
    expect(replay).toEqual(contractResult);
    expect(db.committedCommands.size).toBe(1);
  });
});
