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
  it("keeps a separate purge fence for every destructive mutation", async () => {
    const created: Array<{ payload: unknown }> = [];
    let version = BigInt(0);
    const tx = {
      mainOutboxEvent: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn(async ({ data }: { data: { payload: unknown } }) => {
          created.push(data);
          return data;
        }),
      },
      companionMemoryAuthority: {
        upsert: vi.fn(async () => {
          version += BigInt(1);
          return { version };
        }),
      },
    } as unknown as Prisma.TransactionClient;

    const firstId = await scheduleCompanionMemoryRebuild(tx, {
      userId: "user-1",
      characterId: "character-1",
      purgeRunAttempts: [{ turnId: "turn-1", throughAttempt: 1 }],
    });
    const secondId = await scheduleCompanionMemoryRebuild(tx, {
      userId: "user-1",
      characterId: "character-1",
      purgeRunAttempts: [{ turnId: "turn-1", throughAttempt: 2 }],
    });

    expect(firstId).not.toBe(secondId);
    expect(created).toHaveLength(2);
    expect(created.map(({ payload }) => payload)).toMatchObject([
      { payload: { authorityVersion: "1", purgeRunAttempts: [{ turnId: "turn-1", throughAttempt: 1 }] } },
      { payload: { authorityVersion: "2", purgeRunAttempts: [{ turnId: "turn-1", throughAttempt: 2 }] } },
    ]);
  });
});
