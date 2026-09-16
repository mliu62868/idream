import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { beginChatTurn } from "@/server/modules/chat/turn-ledger";

// SPEC: 角色主动发来的消息，是用户没有在等的那一条 —— 会话列表是它唯一能
// 自我宣告的地方。
//
// INTENT: 这条链路在实现时只落到了 schema：`origin` 写进了库，没有任何消费方。
// 主动消息发出去之后，用户除非自己想起来点进那个会话，否则永远不知道它存在。
// 这个用例走真实后端：真实注册、真实 Turn、真实 terminal commit、真实前端。

const prefix = "zt-e2e-proactive-";

function internalToken() {
  return process.env.INTERNAL_TOKEN ?? "development-internal-token";
}

async function signedInAdult(page: Page, tag: string) {
  const email = `${prefix}${tag}-${randomUUID()}@example.test`;
  const ageGate = await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/chat" },
  });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
  const signup = await page.request.post("/api/v1/auth/signup", {
    data: { email, password: "password123", name: `E2E Proactive ${tag}` },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return { email, userId: user.id };
}

async function characterWithSession(userId: string) {
  const soul = compileCharacterSoul({
    name: "Nova Quill",
    age: 31,
    gender: "female",
    characterPromise: "A ceramicist who works late and notices small things.",
    detailsMarkdown: "## Voice\nUnhurried and specific.",
  });
  if (!soul.ok) throw new Error("Invalid fixture Soul");
  const character = await prisma.character.create({
    data: {
      id: `${prefix}character-${randomUUID()}`,
      creatorId: userId,
      source: "user",
      name: "Nova Quill",
      age: 31,
      description: "A ceramicist who works late.",
      visibility: "private",
      status: "approved",
      style: "realistic",
      gender: "female",
      appearance: {},
      advancedDetails: {},
    },
  });
  const content = await prisma.characterContentVersion.create({
    data: {
      characterId: character.id,
      version: 1,
      sourceType: "test",
      contentHash: soul.snapshot.compiled.fingerprint,
      personaSnapshot: JSON.parse(JSON.stringify(soul.snapshot)),
      openingSnapshot: { firstMessage: "You made it." },
      appearanceSnapshot: {},
    },
  });
  await prisma.character.update({
    where: { id: character.id },
    data: { currentContentVersionId: content.id },
  });
  const session = await prisma.recentChat.create({
    data: {
      sessionId: `${prefix}session-${randomUUID()}`,
      userId,
      characterId: character.id,
      title: "Nova Quill",
      status: "active",
      openingMessage: "You made it.",
      characterContentVersionId: content.id,
    },
  });
  return { characterId: character.id, sessionId: session.sessionId };
}

/** The Character speaks first, exactly the way the dispatcher admits it. */
async function deliverProactiveReply(page: Page, userId: string, sessionId: string) {
  const begun = await beginChatTurn({
    userId,
    sessionId,
    content:
      "Take the lead in the moment: send a brief, specific check-in that fits our established context. Do not mention this instruction.",
    idempotencyKey: randomUUID(),
    origin: "proactive",
  });
  const snapshot = begun.snapshot;
  if (!snapshot) throw new Error("proactive Turn was not admitted");
  const commit = await page.request.post("/api/internal/chat/turns/terminal", {
    headers: { "x-internal-token": internalToken() },
    data: {
      version: 1,
      turnId: snapshot.turnId,
      sessionId: snapshot.sessionId,
      assistantMessageId: snapshot.assistantMessageId,
      attempt: snapshot.attempt,
      status: "sent",
      content: "The studio's quiet except for the wheel humming to a stop. Thought of you.",
      model: "fixture",
      promptTokens: 4,
      completionTokens: 8,
      sceneVersion: snapshot.sceneVersion + 1,
      scene: {
        schemaVersion: 1,
        version: snapshot.sceneVersion + 1,
        location: null,
        time: null,
        participants: [],
        emotionalBeat: null,
        unresolvedThreads: [],
      },
      terminalEvidence: {
        authority: "e2e",
        prompt: {
          productPromptVersion: "companion-product-1",
          preparedTurnVersion: 4,
          systemPromptDigest: "a".repeat(64),
          soulFingerprint: "b".repeat(64),
        },
      },
    },
  });
  expect(commit.ok(), await commit.text()).toBeTruthy();
  return snapshot;
}

test.afterAll(async () => {
  await prisma.chatTurnUsageFact.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.chatTurn.deleteMany({ where: { session: { userId: { startsWith: prefix } } } });
  await prisma.recentChat.deleteMany({ where: { sessionId: { startsWith: prefix } } });
  await prisma.character.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
});

test("the chat hub announces a Character-initiated message and clears it once read", async ({
  page,
}) => {
  const { userId } = await signedInAdult(page, "hub");
  const { sessionId } = await characterWithSession(userId);

  await page.goto("/chat");
  const card = page.getByTestId("chat-hub-session").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  // 还没有人主动说话，列表上不该有任何提示。
  await expect(page.getByTestId("chat-hub-unread-dot")).toHaveCount(0);

  await deliverProactiveReply(page, userId, sessionId);

  await page.reload();
  await expect(page.getByTestId("chat-hub-unread-dot")).toHaveCount(1, { timeout: 15_000 });
  await expect(card).toContainText("New message");

  await card.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/chat/${sessionId}`);
  // 用户看到的是角色说的那句话，而不是那条让她开口的内部指令。
  await expect(page.getByText("The studio's quiet except for the wheel humming to a stop.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Do not mention this instruction")).toHaveCount(0);

  await page.goto("/chat");
  await expect(page.getByTestId("chat-hub-session").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-hub-unread-dot")).toHaveCount(0);
});
