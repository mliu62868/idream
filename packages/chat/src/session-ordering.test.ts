import { describe, expect, it, vi } from "vitest";
import type { ChatPrismaClient } from "./db.js";

// service.ts value-imports ./db.js (real PrismaClient) and ./queue.js (BullMQ/Redis);
// listSessions touches neither once a prisma is injected through the context override.
vi.mock("./db.js", () => ({ chatPrisma: {}, chatProjectorPrisma: {} }));
vi.mock("./queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue.js")>();
  return { ...actual, enqueue: vi.fn(async () => {}) };
});

const { listSessions } = await import("./service.js");

/** Captures the arguments handed to prisma so the query shape itself can be asserted. */
function recordingPrisma() {
  const calls: Array<Record<string, unknown>> = [];
  const prisma = {
    chatSession: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push(args);
        return [];
      },
    },
  } as unknown as ChatPrismaClient;
  return { prisma, calls };
}

describe("recent chat list ordering", () => {
  // SPEC: 最近对话按最后一条消息倒序。
  // INTENT: lastMessageAt 可空（会话建好还没发言就是 NULL）。Postgres 的 DESC 默认
  //         NULLS FIRST，所以不写 nulls:"last" 时，从没说过话的空会话会永远置顶在
  //         真实对话之上 —— 运行库里实测有用户 5 个会话里 1 个是这种，必然中招。
  it("sorts empty sessions last instead of letting NULL float to the top", async () => {
    const { prisma, calls } = recordingPrisma();
    await listSessions("user-1", { prisma });

    expect(calls).toHaveLength(1);
    const orderBy = calls[0].orderBy;
    expect(Array.isArray(orderBy)).toBe(true);
    expect((orderBy as unknown[])[0]).toEqual({
      lastMessageAt: { sort: "desc", nulls: "last" },
    });
  });

  // INVARIANT: 末位必须是唯一列，否则同一毫秒的两条记录在两次查询里顺序可以不同，
  // 分页会丢记录或重复记录。
  it("ends on a unique tiebreaker so paging is stable", async () => {
    const { prisma, calls } = recordingPrisma();
    await listSessions("user-1", { prisma });

    const orderBy = calls[0].orderBy as Array<Record<string, unknown>>;
    expect(orderBy.at(-1)).toEqual({ id: "desc" });
  });

  it("still scopes the list to the caller's undeleted sessions", async () => {
    const { prisma, calls } = recordingPrisma();
    await listSessions("user-1", { prisma });

    expect(calls[0].where).toEqual({ userId: "user-1", status: { not: "deleted" } });
  });
});
