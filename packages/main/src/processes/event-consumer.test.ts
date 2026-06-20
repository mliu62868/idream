// main-event-consumer effects: chat→main events update main authority tables.
import { describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { applyChatEvent } from "./event-consumer";

describe("applyChatEvent", () => {
  it("chat.message.completed bumps character chatsCount", async () => {
    const character = await prisma.character.create({
      data: {
        name: "EC Test",
        age: 24,
        description: "d",
        appearance: {},
        advancedDetails: {},
        stats: { create: { chatsCount: 0 } },
      },
      include: { stats: true },
    });

    await applyChatEvent({
      eventId: "ec1",
      eventType: "chat.message.completed",
      aggregateId: "msg1",
      payload: { characterId: character.id },
    });

    const stats = await prisma.characterStats.findUnique({ where: { characterId: character.id } });
    expect(stats?.chatsCount).toBe(1);
  });

  it("chat.safety.flagged records a moderation event", async () => {
    await applyChatEvent({
      eventId: "ec2",
      eventType: "chat.safety.flagged",
      aggregateId: "msg_flagged",
      payload: { layer: "output", policyCode: "unsafe_request" },
    });
    const event = await prisma.moderationEvent.findFirst({
      where: { targetId: "msg_flagged", status: "flagged" },
    });
    expect(event?.policyCode).toBe("unsafe_request");
  });
});
