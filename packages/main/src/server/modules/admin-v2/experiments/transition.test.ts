import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { transitionExperiment } from "./transition";

describe("transitionExperiment", () => {
  it("performs one versioned from-state CAS", async () => {
    const updates: unknown[] = [];
    const tx = {
      experimentDefinition: {
        findUnique: async () => ({ id: "experiment-1", status: "draft", stateVersion: 3 }),
        updateMany: async (input: unknown) => {
          updates.push(input);
          return { count: 1 };
        },
        findUniqueOrThrow: async () => ({ id: "experiment-1", status: "running", stateVersion: 4 }),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(transitionExperiment(tx, {
      experimentId: "experiment-1",
      to: "running",
      expected: { from: "draft", stateVersion: 3 },
      data: { startedAt: new Date("2026-01-01T00:00:00.000Z"), startedById: "admin-1" },
    })).resolves.toMatchObject({ status: "running", stateVersion: 4 });
    expect(updates).toEqual([{
      where: { id: "experiment-1", status: "draft", stateVersion: 3 },
      data: expect.objectContaining({ status: "running", stateVersion: { increment: 1 } }),
    }]);
  });

  it("rejects an illegal transition before writing", async () => {
    const tx = {
      experimentDefinition: {
        findUnique: async () => ({ id: "experiment-1", status: "running", stateVersion: 3 }),
        updateMany: async () => ({ count: 1 }),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(transitionExperiment(tx, {
      experimentId: "experiment-1",
      to: "running",
      expected: { from: "running", stateVersion: 3 },
      data: {},
    })).rejects.toMatchObject({ code: "conflict" });
  });
});
