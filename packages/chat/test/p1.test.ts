// P1-2 (relationship.md) + P1-3 (account export) acceptance.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createChatPrisma } from "../src/db.js";
import { dispatchChat } from "../src/router.js";
import { processGenerate, type GeneratePayload } from "../src/generate.js";
import { processMemoryExtract } from "../src/memory.js";
import { drainQueue } from "../src/queue.js";
import {
  parseRelationship,
  relationshipSignalForTurn,
  updateRelationshipOnce,
} from "../src/relationship.js";
import { exportAccount } from "../src/export.js";
import { readWhole, chatFsPaths } from "../src/chat-fs.js";
import { withReadableChatFileSnapshot } from "../src/file-mutations.js";
import { CHAT_QUEUES } from "@idream/shared/contracts";
import { acceptAgeGate } from "./fixtures.js";

const prisma = createChatPrisma();
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
let fsRoot: string;
const USER = "u_p1";
const CHAR = "c_p1";

beforeAll(async () => {
  fsRoot = await mkdtemp(path.join(tmpdir(), "chat-p1-"));
  process.env.CHAT_FS_ROOT = fsRoot;
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [USER, "p1@test.dev"],
  );
  await acceptAgeGate(superPool, [USER]);
  await superPool.query(
    `INSERT INTO public.characters (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'P1',25,'d','public','approved','realistic','female','{}','{}',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [CHAR],
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await superPool.end();
  await rm(fsRoot, { recursive: true, force: true });
});

describe("relationship.md (P1-2)", () => {
  it("does not turn neutral message volume into intimacy", async () => {
    let { state } = await updateRelationshipOnce(
      USER,
      "c_p1_neutral",
      "neutral_turn_0",
      { summaryDelta: "User: hello from the launch probe" },
    );
    for (let turn = 1; turn < 30; turn += 1) {
      ({ state } = await updateRelationshipOnce(
        USER,
        "c_p1_neutral",
        `neutral_turn_${turn}`,
        { summaryDelta: `User: routine probe ${turn}` },
      ));
    }

    expect(state.signals).toEqual({
      warmth: 0,
      familiarity: 0,
      turns: 30,
    });
    expect(state.stage).toBe("new");
  });

  it("derives conservative relationship signals from meaningful user language", () => {
    expect(relationshipSignalForTurn("hello from the launch probe")).toEqual({
      warmth: 0,
      familiarity: 0,
    });
    expect(relationshipSignalForTurn("I want a photo by the window.")).toEqual({
      warmth: 0,
      familiarity: 0,
    });
    expect(relationshipSignalForTurn("我需要一张窗边的照片。")).toEqual({
      warmth: 0,
      familiarity: 0,
    });
    expect(relationshipSignalForTurn("我想你帮我生成一张窗边的照片。")).toEqual({
      warmth: 0,
      familiarity: 0,
    });
    expect(
      relationshipSignalForTurn(
        "I miss you and I trust you. My favorite place is the coast.",
      ),
    ).toEqual({
      warmth: 1,
      familiarity: 1,
    });
    expect(relationshipSignalForTurn("我想你，也很信任你。我最喜欢爵士乐。")).toEqual({
      warmth: 1,
      familiarity: 1,
    });
  });

  it("merges signals + advances stage across turns", async () => {
    let { state } = await updateRelationshipOnce(USER, CHAR, "merge_turn_1", { warmth: 1, familiarity: 1, summaryDelta: "first" });
    expect(state.stage).toBe("new"); // score 2 < familiar(6)
    expect(state.version).toBe(1);
    ({ state } = await updateRelationshipOnce(USER, CHAR, "merge_turn_2", { warmth: 10, familiarity: 10, summaryDelta: "more" }));
    expect(state.signals.familiarity).toBe(11);
    expect(state.stage).toBe("close"); // score 22 ≥ close(20)

    const persisted = parseRelationship(await readWhole(chatFsPaths.relationship(USER, CHAR)));
    expect(persisted.stage).toBe("close");
    expect(persisted.summary).toContain("more");
  });
});

describe("account export (P1-3)", () => {
  it("exposes the locked transaction reader to cross-store snapshot callers", async () => {
    const sessionCount = await withReadableChatFileSnapshot(
      USER,
      (tx) => tx.chatSession.count({ where: { userId: USER } }),
      prisma,
    );

    expect(sessionCount).toBeGreaterThanOrEqual(0);
  });

  it("aggregates PG messages + file memories + relationship", async () => {
    const created = await dispatchChat({ method: "POST", path: "/api/v1/chat/sessions", userId: USER, body: { characterId: CHAR } });
    const sessionId = created.kind === "json" ? (created.body as { id: string }).id : "";
    const sent = await dispatchChat({
      method: "POST",
      path: `/api/v1/chat/sessions/${sessionId}/messages`,
      userId: USER,
      body: { content: "call me Robin and i like jazz" },
    });
    const assistantMessageId = sent.kind === "json" ? (sent.body as { assistantMessageId: string }).assistantMessageId : "";
    await drainQueue(CHAT_QUEUES.generate, async (job) => {
      await processGenerate(job.payload as GeneratePayload, prisma);
    });
    await processMemoryExtract({ sessionId, assistantMessageId, attempt: 1 }, prisma);

    const bundle = await exportAccount(USER, new Date(), prisma);
    expect(bundle.userId).toBe(USER);
    expect(bundle.messages.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(bundle.memories.some((m) => m.text.includes("Robin"))).toBe(true);
    expect(bundle.relationships.some((r) => r.characterId === CHAR)).toBe(true);
    expect(bundle.sessions.some((s) => s.id === sessionId)).toBe(true);
  });
});
