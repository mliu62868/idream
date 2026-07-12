import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  transitionGenerationRequest,
  transitionGenerationRequestWithDisposition,
} from "./generation-request-transition";

describe("Generation Request transition authority", () => {
  const suffix = randomUUID();
  const userId = `request-transition-user-${suffix}`;
  const raceJobId = `request-transition-race-${suffix}`;
  const terminalJobId = `request-transition-terminal-${suffix}`;
  const replayJobId = `request-transition-replay-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@idream.internal`,
        role: "user",
        status: "active",
      },
    });
    await prisma.generationJob.createMany({
      data: [
        {
          id: raceJobId,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          status: "running",
          version: 1,
        },
        {
          id: terminalJobId,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          status: "cancelled",
          version: 7,
          errorCode: "operator_cancelled",
        },
        {
          id: replayJobId,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          status: "running",
          version: 4,
          errorCode: "preserve_on_replay",
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.generationJob.deleteMany({ where: { id: { in: [raceJobId, terminalJobId, replayJobId] } } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("lets exactly one concurrent from-state and version CAS win", async () => {
    const settle = (to: "failed" | "blocked", errorCode: string) =>
      prisma.$transaction((tx) => transitionGenerationRequest(tx, {
        requestId: raceJobId,
        to,
        expected: { from: "running", version: 1 },
        data: { errorCode, finishedAt: new Date() },
      }));

    const results = await Promise.allSettled([
      settle("failed", "provider_failed"),
      settle("blocked", "provider_blocked"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const persisted = await prisma.generationJob.findUniqueOrThrow({ where: { id: raceJobId } });
    expect(["failed", "blocked"]).toContain(persisted.status);
    expect(persisted.version).toBe(2);
    expect(persisted.errorCode).toMatch(/^provider_(failed|blocked)$/);
  });

  it("rejects an illegal terminal rewrite without changing any request field", async () => {
    const before = await prisma.generationJob.findUniqueOrThrow({ where: { id: terminalJobId } });

    await expect(prisma.$transaction((tx) => transitionGenerationRequest(tx, {
      requestId: terminalJobId,
      to: "failed",
      expected: { from: "cancelled", version: 7 },
      data: { errorCode: "late_worker_failure", finishedAt: new Date() },
    }))).rejects.toMatchObject({ status: 409 });

    const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: terminalJobId } });
    expect(after).toEqual(before);
  });

  it("treats a stage self-transition as a replay no-op", async () => {
    const result = await prisma.$transaction((tx) =>
      transitionGenerationRequestWithDisposition(tx, {
        requestId: replayJobId,
        to: "running",
        expected: { from: "running", version: 4 },
        data: { errorCode: null },
      }),
    );

    expect(result).toMatchObject({
      disposition: "duplicate",
      request: { status: "running", version: 4, errorCode: "preserve_on_replay" },
    });
    await expect(
      prisma.generationJob.findUniqueOrThrow({ where: { id: replayJobId } }),
    ).resolves.toMatchObject({
      status: "running",
      version: 4,
      errorCode: "preserve_on_replay",
    });
  });
});
