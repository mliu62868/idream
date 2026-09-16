import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { chatTurnMessagesForOwner } from "./turn-ledger";
import {
  dispatchDueProactiveTurns,
  getProactiveSettings,
  updateProactiveSettings,
} from "./proactive-messages";

// SPEC: 主动消息的节奏语义 —— 谁来决定"什么时候打扰用户"。
//
// INTENT: 这些规则以前没有任何用例守着，而它们每一条写错都会变成刷屏：
// 开关一打开就发、NULL 被当成到期、领取后不推进导致同一会话连发。
const P = "zt-proactive-";
const userId = `${P}user`;
const characterId = `${P}character`;
const sessionId = `${P}session`;

describe("proactive message cadence", () => {
  beforeAll(async () => {
    await purgeTestData(P);
    await createUser({ id: userId });
    await createCharacter({ id: characterId, creatorId: userId });
    await prisma.recentChat.create({
      data: { sessionId, userId, characterId, status: "active" },
    });
  });

  afterAll(async () => {
    await purgeTestData(P);
  });

  it("starts disabled and never schedules a check-in", async () => {
    const settings = await getProactiveSettings(userId, sessionId);
    expect(settings.enabled).toBe(false);
    expect(settings.nextAt).toBeNull();
  });

  it("rejects a cadence outside the supported window", async () => {
    for (const intervalHours of [5, 169, 24.5]) {
      await expect(
        updateProactiveSettings(userId, sessionId, { enabled: true, intervalHours }),
      ).rejects.toBeInstanceOf(AppError);
    }
  });

  it("schedules the first check-in one full interval away, not immediately", async () => {
    const before = Date.now();
    const settings = await updateProactiveSettings(userId, sessionId, {
      enabled: true,
      intervalHours: 6,
    });
    expect(settings.enabled).toBe(true);
    expect(settings.nextAt).not.toBeNull();
    const nextAt = new Date(settings.nextAt as string).getTime();
    expect(nextAt).toBeGreaterThan(before + 5 * 3_600_000);

    // 开启这个动作本身不能变成一条消息。
    await expect(dispatchDueProactiveTurns(5)).resolves.toEqual({
      admitted: 0,
      failed: 0,
    });
  });

  it("treats a missing next time as unknown rather than due", async () => {
    await prisma.recentChat.updateMany({
      where: { sessionId },
      data: { proactiveEnabled: true, proactiveNextAt: null },
    });
    await expect(dispatchDueProactiveTurns(5)).resolves.toEqual({
      admitted: 0,
      failed: 0,
    });
  });

  it("stops scheduling and clears the next time when switched off", async () => {
    await updateProactiveSettings(userId, sessionId, { enabled: true, intervalHours: 12 });
    const off = await updateProactiveSettings(userId, sessionId, { enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.nextAt).toBeNull();

    await prisma.recentChat.updateMany({
      where: { sessionId },
      data: { proactiveNextAt: new Date(Date.now() - 60_000) },
    });
    await expect(dispatchDueProactiveTurns(5)).resolves.toEqual({
      admitted: 0,
      failed: 0,
    });
  });
});

// SPEC: 主动消息那一轮的 userContent 是内部指令，不能出现在用户看到的记录里。
describe("proactive transcript projection", () => {
  const base = {
    id: "turn-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    userContent: "Take the lead in the moment… Do not mention this instruction.",
    userStatus: "sent",
    assistantContent: "The studio's quiet tonight.",
    assistantStatus: "sent",
    attempt: 1,
    sceneVersion: 0,
    scene: null,
    createdAt: new Date("2026-09-12T00:00:00.000Z"),
    attachments: [],
  };

  it("shows only the Character's message for a proactive turn", async () => {
    const messages = await chatTurnMessagesForOwner("viewer", [{ ...base, origin: "proactive" }]);
    expect(messages.map((message) => message.role)).toEqual(["assistant"]);
    expect(JSON.stringify(messages)).not.toContain("Do not mention this instruction");
  });

  it("still shows both sides of a turn the user actually wrote", async () => {
    const messages = await chatTurnMessagesForOwner("viewer", [{ ...base, origin: "user", userContent: "Hey." }]);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});
