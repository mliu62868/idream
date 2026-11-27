import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { scheduleCompanionMemoryProjection, scheduleCompanionMemoryRebuild } from "./companion-memory-authority";

describe("companion memory projection scheduling", () => {
  it.each([
    { attempts: 0, claimDuringRead: false, coalesces: true },
    { attempts: 1, claimDuringRead: false, coalesces: false },
    { attempts: 0, claimDuringRead: true, coalesces: false },
  ])("preserves newer source when pending projection has attempts=$attempts and claimDuringRead=$claimDuringRead", async scenario => {
    const candidate = { id: "existing-projection", status: "pending", attempts: scenario.attempts };
    const created: Array<{ id: string; payload: unknown }> = [];
    const tx = {
      mainOutboxEvent: {
        findFirst: vi.fn(async ({ where }: { where: { attempts?: number } }) => {
          if (where.attempts !== undefined && candidate.attempts !== where.attempts) return null;
          if (scenario.claimDuringRead) {
            candidate.status = "processing";
            candidate.attempts = 1;
          }
          return { id: candidate.id };
        }),
        updateMany: vi.fn(async ({ where }: { where: { id: string; status: string; attempts: number } }) => ({
          count: candidate.id === where.id && candidate.status === where.status && candidate.attempts === where.attempts ? 1 : 0,
        })),
        create: vi.fn(async ({ data }: { data: { id: string; payload: unknown } }) => {
          created.push(data);
          return data;
        }),
      },
      companionMemoryAuthority: { upsert: vi.fn().mockResolvedValue({ version: BigInt(2) }) },
    } as unknown as Prisma.TransactionClient;
    const scheduled = await scheduleCompanionMemoryProjection(tx, { userId: "user-1", characterId: "character-1" });
    if (scenario.coalesces) {
      expect(scheduled).toBe("existing-projection");
      expect(created).toEqual([]);
    } else {
      expect(scheduled).not.toBe("existing-projection");
      expect(created).toMatchObject([{ id: scheduled, payload: { payload: { authorityVersion: "2" } } }]);
    }
  });
});

describe("companion memory destructive scheduling", () => {
  function destructiveTx(unclaimed: { id: string; payload: unknown } | null, coalesceCount = 1) {
    const created: Array<{ id: string; payload: unknown }> = [];
    const widened: Array<unknown> = [];
    let version = BigInt(0);
    const tx = {
      mainOutboxEvent: {
        findFirst: vi.fn().mockResolvedValue(unclaimed),
        updateMany: vi.fn(async ({ data }: { data: { payload?: unknown } }) => {
          if (data.payload !== undefined) { widened.push(data.payload); return { count: coalesceCount }; }
          return { count: 0 };
        }),
        create: vi.fn(async ({ data }: { data: { id: string; payload: unknown } }) => { created.push(data); return data; }),
      },
      companionMemoryAuthority: {
        upsert: vi.fn(async () => { version += BigInt(1); return { version }; }),
      },
    } as unknown as Prisma.TransactionClient;
    return { tx, created, widened };
  }

  it("queues a separate purge fence behind a claimed rebuild", async () => {
    const { tx, created } = destructiveTx(null);
    const firstId = await scheduleCompanionMemoryRebuild(tx, {
      userId: "user-1", characterId: "character-1", purgeRunAttempts: [{ turnId: "turn-1", throughAttempt: 1 }],
    });
    const secondId = await scheduleCompanionMemoryRebuild(tx, {
      userId: "user-1", characterId: "character-1", purgeRunAttempts: [{ turnId: "turn-1", throughAttempt: 2 }],
    });
    expect(firstId).not.toBe(secondId);
    expect(created.map(({ payload }) => payload)).toMatchObject([
      { payload: { authorityVersion: "1", purgeRunAttempts: [{ turnId: "turn-1", throughAttempt: 1 }] } },
      { payload: { authorityVersion: "2", purgeRunAttempts: [{ turnId: "turn-1", throughAttempt: 2 }] } },
    ]);
  });

  it("widens an unclaimed rebuild instead of queueing another whole-relationship rebuild", async () => {
    const pending = {
      sourceService: "main", sourceEventId: "rebuild-1", eventType: "chat.companion_memory.rebuild_requested.v1",
      schemaVersion: 1, occurredAt: new Date(0).toISOString(), aggregateType: "chat_relationship", aggregateId: "user-1:character-1",
      payload: { version: 1, userId: "user-1", characterId: "character-1", claimToken: "11111111-1111-4111-8111-111111111111",
        authorityVersion: "1", purgeTurnIds: ["turn-0"], purgeRunAttempts: [{ turnId: "turn-1", throughAttempt: 1 }] },
    };
    const { tx, created, widened } = destructiveTx({ id: "rebuild-1", payload: pending });
    const id = await scheduleCompanionMemoryRebuild(tx, {
      userId: "user-1", characterId: "character-1", purgeRunAttempts: [{ turnId: "turn-1", throughAttempt: 2 }, { turnId: "turn-2", throughAttempt: 1 }],
    });
    expect(id).toBe("rebuild-1");
    expect(created).toEqual([]);
    expect(widened).toMatchObject([{ payload: {
      authorityVersion: "1",
      purgeTurnIds: ["turn-0"],
      purgeRunAttempts: expect.arrayContaining([{ turnId: "turn-1", throughAttempt: 2 }, { turnId: "turn-2", throughAttempt: 1 }]),
    } }]);
  });

  it("queues a new rebuild when a claim wins the race to the unclaimed one", async () => {
    const pending = {
      sourceService: "main", sourceEventId: "rebuild-1", eventType: "chat.companion_memory.rebuild_requested.v1",
      schemaVersion: 1, occurredAt: new Date(0).toISOString(), aggregateType: "chat_relationship", aggregateId: "user-1:character-1",
      payload: { version: 1, userId: "user-1", characterId: "character-1", claimToken: "11111111-1111-4111-8111-111111111111",
        authorityVersion: "1", purgeTurnIds: [], purgeRunAttempts: [] },
    };
    const { tx, created } = destructiveTx({ id: "rebuild-1", payload: pending }, 0);
    const id = await scheduleCompanionMemoryRebuild(tx, { userId: "user-1", characterId: "character-1", purgeTurnIds: ["turn-9"] });
    expect(id).not.toBe("rebuild-1");
    expect(created).toHaveLength(1);
  });
});
