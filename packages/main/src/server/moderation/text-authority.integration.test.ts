import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { moderateText } from "./text-authority";

describe("text moderation authority", () => {
  const targetId = `text-moderation-authority-${randomUUID()}`;

  afterEach(async () => {
    await prisma.moderationEvent.deleteMany({ where: { targetId } });
  });

  it("returns a decision only after persisting the matching event", async () => {
    const decision = await moderateText(
      "authority_test",
      targetId,
      "an ordinary character greeting",
      "input",
    );

    await expect(prisma.moderationEvent.findFirstOrThrow({
      where: { targetId },
      select: {
        targetType: true,
        layer: true,
        status: true,
        policyCode: true,
        confidence: true,
      },
    })).resolves.toEqual({
      targetType: "authority_test",
      layer: "input",
      status: decision.status,
      policyCode: decision.policyCode ?? null,
      confidence: decision.confidence,
    });
  });
});
