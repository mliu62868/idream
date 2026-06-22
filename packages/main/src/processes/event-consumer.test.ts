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

  it("maintains the recent-chats projection across created → completed → deleted", async () => {
    const user = await prisma.user.create({ data: { email: `ec-proj-${Date.now()}@t.dev`, status: "active" } });
    const character = await prisma.character.create({
      data: { name: "ProjChar", age: 24, description: "d", appearance: {}, advancedDetails: {} },
    });
    const sessionId = `sess_proj_${Date.now()}`;

    // session.created seeds the projection row
    await applyChatEvent({
      eventId: "p1",
      eventType: "chat.session.created",
      aggregateId: sessionId,
      payload: { userId: user.id, characterId: character.id },
    });
    let row = await prisma.recentChat.findUnique({ where: { sessionId } });
    expect(row?.userId).toBe(user.id);
    expect(row?.status).toBe("active");

    // message.completed bumps lastMessageAt
    await applyChatEvent({
      eventId: "p2",
      eventType: "chat.message.completed",
      aggregateId: "msg_x",
      payload: { sessionId, userId: user.id, characterId: character.id },
    });
    row = await prisma.recentChat.findUnique({ where: { sessionId } });
    expect(row?.lastMessageAt).toBeTruthy();

    // session.deleted hides it from the library
    await applyChatEvent({ eventId: "p3", eventType: "chat.session.deleted", aggregateId: sessionId, payload: { userId: user.id } });
    row = await prisma.recentChat.findUnique({ where: { sessionId } });
    expect(row?.status).toBe("deleted");
  });
});
