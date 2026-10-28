import { createHash, randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { createUser } from "@/server/test/helpers";
import { freezeGenerationSource, GENERATION_SOURCE_MAX_BYTES } from "./generation-source-snapshot";
import { lockUserLedger } from "./subscription-lifecycle";

it("stores and reads a maximum-size snapshot atomically and removes it with its owner", async () => {
  const userId = `snapshot-capacity-${crypto.randomUUID()}`;
  const otherUserId = `${userId}-other`;
  await createUser({ id: userId }); await createUser({ id: otherUserId });
  const bytes = randomBytes(GENERATION_SOURCE_MAX_BYTES);
  const digest = createHash("sha256").update(bytes).digest("hex");
  try {
    await expect(prisma.$transaction(async tx => {
      await freezeGenerationSource(tx, { userId, bytes, contentType: "image/png" });
      throw new Error("rollback fixture");
    }, { timeout: 60_000 })).rejects.toThrow("rollback fixture");
    expect(await prisma.generationSourceSnapshot.count({ where: { userId } })).toBe(0);
    const [snapshot, otherSnapshot] = await Promise.all([userId, otherUserId].map(id => prisma.$transaction(async tx => {
      await lockUserLedger(tx, id);
      return freezeGenerationSource(tx, { userId: id, bytes, contentType: "image/png" });
    }, { timeout: 60_000 })));
    expect(snapshot!.id).not.toBe(otherSnapshot!.id);
    const duplicate = await Promise.all([0, 1].map(() => prisma.$transaction(async tx => {
      await lockUserLedger(tx, userId);
      return freezeGenerationSource(tx, { userId, bytes, contentType: "image/png" });
    }, { timeout: 60_000 })));
    expect(duplicate.map(item => item.id)).toEqual([snapshot!.id, snapshot!.id]);
    const readHash = createHash("sha256");
    for (let ordinal = 0; ordinal < 1024; ordinal += 16) {
      const chunks = await prisma.generationSourceSnapshotChunk.findMany({ where: { snapshotId: snapshot!.id, ordinal: { gte: ordinal, lt: ordinal + 16 } }, orderBy: { ordinal: "asc" } });
      expect(chunks).toHaveLength(16);
      for (const chunk of chunks) readHash.update(chunk.bytes);
    }
    expect(snapshot!.sha256).toBe(digest);
    expect(readHash.digest("hex")).toBe(digest);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  }
  expect(await prisma.generationSourceSnapshot.count({ where: { userId } })).toBe(0);
}, 120_000);
