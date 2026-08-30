import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { scheduleCompanionMemoryRebuild } from "./companion-memory-authority";

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
