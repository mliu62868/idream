import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPrismaClient } from "./db.js";

// service.ts value-imports ./db.js (constructs a real PrismaClient → needs a live
// Postgres) and ./queue.js (BullMQ/Redis). Neither is exercised here: regenerate's
// eligibility + quota guards throw BEFORE any enqueue, and we inject a fake prisma.
// Mock db.js entirely; keep queue.js real but stub enqueue so the happy path can
// assert it was kicked without touching Redis.
const enqueueMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./db.js", () => ({ chatPrisma: {} }));
vi.mock("./queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue.js")>();
  return { ...actual, enqueue: enqueueMock };
});

const { ChatError, regenerate } = await import("./service.js");

interface FakeData {
  message?: unknown;
  session?: unknown;
  user?: unknown;
  character?: unknown;
  eligibility?: unknown;
  entitlement?: unknown;
  usage?: unknown;
}

function fakePrisma(data: FakeData): ChatPrismaClient {
  const unique = (value: unknown) => async () => value;
  return {
    message: {
      findUnique: unique(data.message ?? null),
      findFirst: async () => null,
      update: async () => ({}),
    },
    chatSession: { findUnique: unique(data.session ?? null) },
    chatUserView: { findUnique: unique(data.user ?? null) },
    chatCharacterView: { findUnique: unique(data.character ?? null) },
    chatUserEligibilityView: { findUnique: unique(data.eligibility ?? null) },
    chatEntitlementView: { findUnique: unique(data.entitlement ?? null) },
    chatUsage: { findUnique: unique(data.usage ?? null) },
  } as unknown as ChatPrismaClient;
}

const assistantMessage = {
  id: "msg_a",
  role: "assistant",
  sessionId: "sess1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  attempt: 1,
};
const session = { id: "sess1", userId: "u1", characterId: "c1", memoryEnabled: true, status: "active" };
const activeUser = { userId: "u1", status: "active", deletedAt: null };
const approvedCharacter = { characterId: "c1", status: "approved", creatorId: "creator", age: 22 };
const noRestriction = { userId: "u1", restrictedReason: null };
const freeEntitlement = {
  userId: "u1",
  modelTier: "free",
  memoryMultiplier: 1,
  unlimitedMessages: false,
  voiceEnabled: false,
};

describe("regenerate quota + eligibility guard (P0-C)", () => {
  beforeEach(() => enqueueMock.mockClear());

  it("rejects a free user already at the daily cap", async () => {
    const prisma = fakePrisma({
      message: assistantMessage,
      session,
      user: activeUser,
      character: approvedCharacter,
      eligibility: noRestriction,
      entitlement: freeEntitlement,
      usage: { messagesUsed: 30 }, // FREE_DAILY_MESSAGES
    });

    await expect(regenerate({ userId: "u1", messageId: "msg_a" }, { prisma })).rejects.toMatchObject({
      code: "quota_exceeded",
      status: 402,
    });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("rejects a suspended user (assertEligible)", async () => {
    const prisma = fakePrisma({
      message: assistantMessage,
      session,
      user: { userId: "u1", status: "suspended", deletedAt: null },
      character: approvedCharacter,
      eligibility: noRestriction,
      entitlement: freeEntitlement,
    });

    await expect(regenerate({ userId: "u1", messageId: "msg_a" }, { prisma })).rejects.toMatchObject({
      code: "user_inactive",
      status: 403,
    });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("allows a free user under the cap and enqueues the new attempt", async () => {
    const prisma = fakePrisma({
      message: assistantMessage,
      session,
      user: activeUser,
      character: approvedCharacter,
      eligibility: noRestriction,
      entitlement: freeEntitlement,
      usage: { messagesUsed: 5 },
    });

    const result = await regenerate({ userId: "u1", messageId: "msg_a" }, { prisma });

    expect(result.attempt).toBe(2);
    expect(result.assistantMessageId).toBe("msg_a");
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("is a ChatError on the quota path", async () => {
    const prisma = fakePrisma({
      message: assistantMessage,
      session,
      user: activeUser,
      character: approvedCharacter,
      eligibility: noRestriction,
      entitlement: freeEntitlement,
      usage: { messagesUsed: 999 },
    });

    await expect(regenerate({ userId: "u1", messageId: "msg_a" }, { prisma })).rejects.toBeInstanceOf(
      ChatError,
    );
  });
});
