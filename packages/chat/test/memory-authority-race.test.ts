import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import {
  createChatPrisma,
  createChatProjectorPrisma,
} from "../src/db.js";
import { processMemoryExtract } from "../src/memory.js";
import { listMemories } from "../src/memories.js";
import {
  getRelationshipState,
  relationshipTurnSummary,
  renderRelationship,
} from "../src/relationship.js";
import { editUserMessage, regenerate } from "../src/service.js";
import { processGenerate } from "../src/generate.js";
import { deleteMessage, deleteSession } from "../src/privacy.js";
import {
  chatFsPaths,
  readWhole,
  writeAtomic,
} from "../src/chat-fs.js";
import { obliterate } from "../src/queue.js";
import { CHAT_QUEUES } from "@idream/shared/contracts";
import { acceptAgeGate } from "./fixtures.js";

const prisma = createChatPrisma();
const projectorPrisma = createChatProjectorPrisma();
const superPool = new Pool({
  connectionString: process.env.CHAT_TEST_SUPER_URL,
});
const CHAR = "memory_race_character";
const USERS = {
  edit: "memory_race_edit_user",
  regenerate: "memory_race_regenerate_user",
  delete: "memory_race_delete_user",
  cleanup: "memory_race_cleanup_user",
  linkage: "memory_race_linkage_user",
  context: "memory_race_context_user",
  scale: "memory_race_scale_user",
  legacyEdit: "memory_race_legacy_edit_user",
  legacyDelete: "memory_race_legacy_delete_user",
} as const;
let fsRoot: string;

interface Turn {
  assistantMessageId: string;
  sessionId: string;
  userMessageId: string;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createCompletedTurn(
  userId: string,
  suffix: string,
  content: string,
): Promise<Turn> {
  const sessionId = `memory_race_session_${suffix}`;
  const userMessageId = `memory_race_user_message_${suffix}`;
  const assistantMessageId = `memory_race_assistant_${suffix}`;
  await prisma.chatSession.create({
    data: {
      id: sessionId,
      userId,
      characterId: CHAR,
      status: "active",
      memoryEnabled: true,
    },
  });
  await prisma.message.create({
    data: {
      id: userMessageId,
      sessionId,
      role: "user",
      content,
      status: "sent",
      safetyStatus: "passed",
    },
  });
  await prisma.message.create({
    data: {
      id: assistantMessageId,
      sessionId,
      role: "assistant",
      content: "completed reply",
      status: "sent",
      safetyStatus: "passed",
      attempt: 1,
      replyToMessageId: userMessageId,
      memoryAuthority: "enabled",
    },
  });
  return { assistantMessageId, sessionId, userMessageId };
}

function extractPayload(turn: Turn) {
  return {
    sessionId: turn.sessionId,
    assistantMessageId: turn.assistantMessageId,
    userMessageId: turn.userMessageId,
    attempt: 1,
  };
}

async function expectNoDerivedState(userId: string, contentNeedle: string) {
  expect(await listMemories(userId, CHAR)).toEqual([]);
  const relationship = await getRelationshipState(userId, CHAR);
  expect(relationship.signals.turns).toBe(0);
  expect(relationship.summary).not.toContain(contentNeedle);
}

beforeAll(async () => {
  fsRoot = await mkdtemp(path.join(tmpdir(), "chat-memory-race-"));
  process.env.CHAT_FS_ROOT = fsRoot;
  for (const userId of Object.values(USERS)) {
    await superPool.query(
      `INSERT INTO public.users
         (id,email,status,"createdAt","updatedAt")
       VALUES ($1,$2,'active',now(),now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@test.dev`],
    );
  }
  await acceptAgeGate(superPool, Object.values(USERS));
  await superPool.query(
    `INSERT INTO public.characters
       (id,name,age,description,visibility,status,style,gender,appearance,
        "advancedDetails","createdAt","updatedAt")
     VALUES
       ($1,'Memory Race',24,'d','public','approved','realistic','female',
        '{}','{}',now(),now())
     ON CONFLICT (id) DO NOTHING`,
    [CHAR],
  );
});

afterEach(async () => {
  await obliterate(CHAT_QUEUES.generate).catch(() => {});
  await obliterate(CHAT_QUEUES.memoryExtract).catch(() => {});
});

afterAll(async () => {
  await prisma.$disconnect();
  await projectorPrisma.$disconnect();
  await superPool.end();
  await rm(fsRoot, { recursive: true, force: true });
});

describe("memory extraction turn authority", () => {
  it("edit wins before the authority lock and stale content never reaches files or outbox", async () => {
    const turn = await createCompletedTurn(
      USERS.edit,
      "edit",
      "call me BeforeEdit and I like old apples",
    );
    const reached = deferred();
    const resume = deferred();
    const extraction = processMemoryExtract(
      extractPayload(turn),
      prisma,
      {
        beforeAuthorityLock: async () => {
          reached.resolve();
          await resume.promise;
        },
      },
    );
    await reached.promise;
    await editUserMessage(
      {
        userId: USERS.edit,
        messageId: turn.userMessageId,
        content: "call me AfterEdit and I like fresh pears",
      },
      { prisma },
    );
    resume.resolve();

    await expect(extraction).resolves.toEqual({
      written: 0,
      skipped: "stale_attempt",
    });
    await expectNoDerivedState(USERS.edit, "BeforeEdit");
    expect(
      await prisma.chatOutboxEvent.count({
        where: {
          eventType: {
            in: [
              "chat.relationship.updated",
              "chat.memory.updated",
            ],
          },
          payload: { path: ["userId"], equals: USERS.edit },
        },
      }),
    ).toBe(0);
    expect(
      await prisma.message.findUnique({
        where: { id: turn.assistantMessageId },
        select: { attempt: true, memoryExtractedAttempt: true },
      }),
    ).toEqual({ attempt: 2, memoryExtractedAttempt: 0 });
  });

  it("regenerate wins before the authority lock and the stale attempt cannot advance", async () => {
    const turn = await createCompletedTurn(
      USERS.regenerate,
      "regenerate",
      "call me StaleRegenerate and I like stale tea",
    );
    const reached = deferred();
    const resume = deferred();
    const extraction = processMemoryExtract(
      extractPayload(turn),
      prisma,
      {
        beforeAuthorityLock: async () => {
          reached.resolve();
          await resume.promise;
        },
      },
    );
    await reached.promise;
    await regenerate(
      {
        userId: USERS.regenerate,
        messageId: turn.assistantMessageId,
      },
      { prisma },
    );
    resume.resolve();

    await expect(extraction).resolves.toEqual({
      written: 0,
      skipped: "stale_attempt",
    });
    await expectNoDerivedState(USERS.regenerate, "StaleRegenerate");
    expect(
      await prisma.message.findUnique({
        where: { id: turn.assistantMessageId },
        select: { attempt: true, memoryExtractedAttempt: true },
      }),
    ).toEqual({ attempt: 2, memoryExtractedAttempt: 0 });
  });

  it("session deletion wins before the authority lock and deleted content cannot be reintroduced", async () => {
    const turn = await createCompletedTurn(
      USERS.delete,
      "delete",
      "call me DeletedSecret and I like deleted coffee",
    );
    const reached = deferred();
    const resume = deferred();
    const extraction = processMemoryExtract(
      extractPayload(turn),
      prisma,
      {
        beforeAuthorityLock: async () => {
          reached.resolve();
          await resume.promise;
        },
      },
    );
    await reached.promise;
    await deleteSession(
      { userId: USERS.delete, sessionId: turn.sessionId },
      prisma,
    );
    resume.resolve();

    await expect(extraction).resolves.toEqual({
      written: 0,
      skipped: "no_session",
    });
    await expectNoDerivedState(USERS.delete, "DeletedSecret");
    expect(
      await prisma.chatOutboxEvent.count({
        where: {
          eventType: {
            in: [
              "chat.relationship.updated",
              "chat.memory.updated",
            ],
          },
          payload: { path: ["userId"], equals: USERS.delete },
        },
      }),
    ).toBe(0);
  });

  it("a later session deletion retracts already-derived file authority", async () => {
    const turn = await createCompletedTurn(
      USERS.cleanup,
      "cleanup",
      "call me CleanupSecret and I like cleanup cocoa",
    );
    await expect(
      processMemoryExtract(extractPayload(turn), prisma),
    ).resolves.toMatchObject({ skipped: null });
    expect(await listMemories(USERS.cleanup, CHAR)).not.toEqual([]);
    const relationship = await getRelationshipState(USERS.cleanup, CHAR);
    expect(relationship.signals.turns).toBe(1);
    // Relationship state is a qualitative projection; raw user secrets stay
    // only in source-linked memory/evidence authority and never in its summary.
    expect(relationship.summary).toContain("self-disclosure");
    expect(relationship.summary).not.toContain("CleanupSecret");

    await deleteSession(
      { userId: USERS.cleanup, sessionId: turn.sessionId },
      prisma,
    );
    await expectNoDerivedState(USERS.cleanup, "CleanupSecret");
    const payloads = await prisma.chatFileMutation.findMany({
      where: { userId: USERS.cleanup },
      select: { payload: true, status: true },
    });
    expect(payloads.every((row) => row.status === "applied")).toBe(true);
    expect(JSON.stringify(payloads)).not.toContain("CleanupSecret");
    expect(JSON.stringify(payloads)).not.toContain("cleanup cocoa");
  });
});

describe("legacy linkage and context privacy fences", () => {
  it("fails closed instead of guessing between two legacy assistants", async () => {
    const sessionId = "memory_race_ambiguous_edit_session";
    const userMessageId = "memory_race_ambiguous_edit_user";
    const createdAt = new Date("2026-07-18T12:00:00.000Z");
    await prisma.chatSession.create({
      data: {
        id: sessionId,
        userId: USERS.linkage,
        characterId: CHAR,
        status: "active",
      },
    });
    await prisma.message.create({
      data: {
        id: userMessageId,
        sessionId,
        role: "user",
        content: "original legacy text",
        status: "sent",
        safetyStatus: "passed",
        createdAt,
        updatedAt: createdAt,
      },
    });
    await prisma.message.createMany({
      data: ["a", "b"].map((suffix) => ({
        id: `memory_race_ambiguous_assistant_${suffix}`,
        sessionId,
        role: "assistant",
        content: `legacy ${suffix}`,
        status: "sent",
        safetyStatus: "passed",
        replyToMessageId: null,
        createdAt,
        updatedAt: createdAt,
      })),
    });

    await expect(
      editUserMessage(
        {
          userId: USERS.linkage,
          messageId: userMessageId,
          content: "must not choose one assistant",
        },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: "message_conflict" });

    expect(
      await prisma.message.findMany({
        where: {
          id: {
            in: [
              "memory_race_ambiguous_assistant_a",
              "memory_race_ambiguous_assistant_b",
            ],
          },
        },
        orderBy: { id: "asc" },
        select: { content: true, attempt: true },
      }),
    ).toEqual([
      { content: "legacy a", attempt: 1 },
      { content: "legacy b", attempt: 1 },
    ]);
  });

  it("marks a post-cutover replacement assistant with exact memory authority", async () => {
    const sessionId = "memory_race_new_edit_assistant_session";
    const userMessageId = "memory_race_new_edit_assistant_user";
    await prisma.chatSession.create({
      data: {
        id: sessionId,
        userId: USERS.linkage,
        characterId: CHAR,
        status: "active",
        memoryEnabled: true,
      },
    });
    await prisma.message.create({
      data: {
        id: userMessageId,
        sessionId,
        role: "user",
        content: "first draft",
        status: "sent",
        safetyStatus: "passed",
      },
    });

    const edited = await editUserMessage(
      {
        userId: USERS.linkage,
        messageId: userMessageId,
        content: "second draft",
      },
      { prisma },
    );
    expect(
      await prisma.message.findUnique({
        where: { id: edited.assistantMessageId },
        select: { memoryAuthority: true, replyToMessageId: true },
      }),
    ).toEqual({
      memoryAuthority: "enabled",
      replyToMessageId: userMessageId,
    });
  });

  it("rejects an in-flight generation after older context is deleted", async () => {
    const older = await createCompletedTurn(
      USERS.context,
      "context_fence",
      "PrivateOldContext must never be revived",
    );
    await prisma.chatSession.update({
      where: { id: older.sessionId },
      data: {
        memorySummary: "PrivateOldContext summary",
      },
    });
    const currentUserMessageId = "memory_race_context_current_user";
    const currentAssistantMessageId =
      "memory_race_context_current_assistant";
    await prisma.message.create({
      data: {
        id: currentUserMessageId,
        sessionId: older.sessionId,
        role: "user",
        content: "current question",
        status: "sent",
        safetyStatus: "passed",
      },
    });
    await prisma.message.create({
      data: {
        id: currentAssistantMessageId,
        sessionId: older.sessionId,
        role: "assistant",
        content: "",
        status: "pending",
        safetyStatus: "unknown",
        memoryAuthority: "enabled",
        replyToMessageId: currentUserMessageId,
      },
    });
    const reached = deferred();
    const resume = deferred();
    const generation = processGenerate(
      {
        sessionId: older.sessionId,
        assistantMessageId: currentAssistantMessageId,
        userMessageId: currentUserMessageId,
        attempt: 1,
      },
      prisma,
      {
        afterContextBuilt: async () => {
          reached.resolve();
          await resume.promise;
        },
      },
    );
    await reached.promise;
    await deleteMessage(
      { userId: USERS.context, messageId: older.userMessageId },
      prisma,
    );
    resume.resolve();

    await expect(generation).resolves.toEqual({ status: "failed" });
    expect(
      await prisma.message.findUnique({
        where: { id: currentAssistantMessageId },
        select: { status: true, content: true },
      }),
    ).toEqual({ status: "failed", content: "" });
    expect(
      await prisma.chatSession.findUnique({
        where: { id: older.sessionId },
        select: { memorySummary: true },
      }),
    ).toEqual({ memorySummary: null });
    const payloads = await prisma.chatFileMutation.findMany({
      where: { userId: USERS.context },
      select: { payload: true },
    });
    expect(JSON.stringify(payloads)).not.toContain("PrivateOldContext");
  });
});

describe("canonical relationship rebuild", () => {
  it("retains an unaffected pre-ledger turn and normalizes its legacy assistantId:attempt key after edit", async () => {
    const edited = await createCompletedTurn(
      USERS.legacyEdit,
      "legacy_edit_target",
      "legacy edit secret must disappear",
    );
    const retained = await createCompletedTurn(
      USERS.legacyEdit,
      "legacy_edit_retained",
      "legacy edit history must remain",
    );
    await prisma.message.updateMany({
      where: {
        id: {
          in: [
            edited.assistantMessageId,
            retained.assistantMessageId,
          ],
        },
      },
      data: { memoryExtractedAttempt: 1 },
    });
    expect(
      Number(
        (
          await superPool.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM chat.chat_file_mutations
              WHERE user_id = $1`,
            [USERS.legacyEdit],
          )
        ).rows[0]?.count ?? "-1",
      ),
    ).toBe(0);
    await writeAtomic(
      chatFsPaths.relationship(USERS.legacyEdit, CHAR),
      renderRelationship(
        {
          stage: "new",
          signals: { warmth: 2, familiarity: 2, turns: 2 },
          summary: [
            relationshipTurnSummary(
              "legacy edit secret must disappear",
            ),
            relationshipTurnSummary(
              "legacy edit history must remain",
            ),
          ].join("\n"),
          version: 2,
        },
        [
          `${edited.assistantMessageId}:1`,
          `${retained.assistantMessageId}:1`,
        ],
      ),
    );

    await editUserMessage(
      {
        userId: USERS.legacyEdit,
        messageId: edited.userMessageId,
        content: "replacement text has no old secret",
      },
      { prisma },
    );

    const state = await getRelationshipState(
      USERS.legacyEdit,
      CHAR,
    );
    expect(state.signals).toEqual({
      warmth: 0,
      familiarity: 0,
      turns: 1,
    });
    expect(state.summary).toContain(
      "legacy edit history must remain",
    );
    expect(state.summary).not.toContain(
      "legacy edit secret must disappear",
    );
    const raw =
      (await readWhole(
        chatFsPaths.relationship(USERS.legacyEdit, CHAR),
      )) ?? "";
    const keys = JSON.parse(
      raw.match(/^applied_turn_keys:\s*(.+)$/m)?.[1] ?? "[]",
    ) as string[];
    expect(keys).toEqual([retained.assistantMessageId]);
    expect(raw).toContain("cutover_baseline:");
  });

  it("repairs a keyless pre-ledger file after session deletion without clearing retained history or reviving deleted prose", async () => {
    const deleted = await createCompletedTurn(
      USERS.legacyDelete,
      "legacy_delete_target",
      "legacy deleted body must disappear",
    );
    const retained = await createCompletedTurn(
      USERS.legacyDelete,
      "legacy_delete_retained",
      "legacy surviving body must remain",
    );
    await prisma.message.updateMany({
      where: {
        id: {
          in: [
            deleted.assistantMessageId,
            retained.assistantMessageId,
          ],
        },
      },
      data: { memoryExtractedAttempt: 1 },
    });
    expect(
      Number(
        (
          await superPool.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM chat.chat_file_mutations
              WHERE user_id = $1`,
            [USERS.legacyDelete],
          )
        ).rows[0]?.count ?? "-1",
      ),
    ).toBe(0);
    await writeAtomic(
      chatFsPaths.relationship(USERS.legacyDelete, CHAR),
      renderRelationship({
        stage: "new",
        signals: { warmth: 2, familiarity: 2, turns: 2 },
        summary: [
          relationshipTurnSummary(
            "legacy deleted body must disappear",
          ),
          relationshipTurnSummary(
            "legacy surviving body must remain",
          ),
        ].join("\n"),
        version: 2,
      }),
    );

    await deleteSession(
      {
        userId: USERS.legacyDelete,
        sessionId: deleted.sessionId,
      },
      prisma,
    );

    const state = await getRelationshipState(
      USERS.legacyDelete,
      CHAR,
    );
    expect(state.signals).toEqual({
      warmth: 0,
      familiarity: 0,
      turns: 1,
    });
    expect(state.summary).toContain(
      "legacy surviving body must remain",
    );
    expect(state.summary).not.toContain(
      "legacy deleted body must disappear",
    );
    const raw =
      (await readWhole(
        chatFsPaths.relationship(USERS.legacyDelete, CHAR),
      )) ?? "";
    const keys = JSON.parse(
      raw.match(/^applied_turn_keys:\s*(.+)$/m)?.[1] ?? "[]",
    ) as string[];
    expect(keys).toEqual([retained.assistantMessageId]);
    expect(raw).toContain("cutover_baseline:");
  });

  it("repairs a truncated 301-turn file and removes the deleted oldest turn", async () => {
    expect(
      await projectorPrisma.$queryRaw<
        Array<{ role: string; database: string }>
      >`
        SELECT
          current_user::text AS role,
          current_database()::text AS database
      `,
    ).toEqual([
      {
        role: "chat_projector",
        database: process.env.CHAT_TEST_DB,
      },
    ]);
    const sessionId = "memory_race_scale_session";
    await prisma.chatSession.create({
      data: {
        id: sessionId,
        userId: USERS.scale,
        characterId: CHAR,
        status: "active",
      },
    });
    const turnCount = 301;
    const messageRows = Array.from(
      { length: turnCount },
      (_, index) => {
        const createdAt = new Date(
          Date.UTC(2026, 6, 18, 15, 0, index),
        );
        const userMessageId = `memory_race_scale_user_${index}`;
        const assistantMessageId =
          `memory_race_scale_assistant_${index}`;
        return [
          {
            id: userMessageId,
            sessionId,
            role: "user",
            content: `scale secret ${index}`,
            status: "sent",
            safetyStatus: "passed",
            createdAt,
            updatedAt: createdAt,
          },
          {
            id: assistantMessageId,
            sessionId,
            role: "assistant",
            content: `reply ${index}`,
            status: "sent",
            safetyStatus: "passed",
            attempt: 1,
            replyToMessageId: userMessageId,
            memoryAuthority: "enabled",
            memoryExtractedAttempt: 1,
            createdAt,
            updatedAt: createdAt,
          },
        ];
      },
    ).flat();
    await prisma.message.createMany({ data: messageRows });
    await prisma.$transaction(
      async (tx) => {
        for (let index = 0; index < turnCount; index += 1) {
          const payload = JSON.stringify({
            kind: "memory_extract",
            sessionId,
            userMessageId: `memory_race_scale_user_${index}`,
            characterId: CHAR,
            turnKey: `memory_race_scale_assistant_${index}`,
            attempt: 1,
            summaryDelta: `User: scale secret ${index}`,
            candidates: [],
            maxStored: 0,
          });
          await tx.$executeRaw`
            INSERT INTO chat.chat_file_mutations (
              id,
              user_id,
              kind,
              payload
            )
            VALUES (
              ${`memory_race_scale_extract_${index}`},
              ${USERS.scale},
              'memory_extract',
              ${payload}::jsonb
            )
          `;
        }
      },
      { timeout: 30_000 },
    );
    await projectorPrisma.$executeRaw`
      UPDATE chat.chat_file_mutations
      SET status = 'applied',
          payload = chat.redact_file_mutation_payload(id, kind, payload),
          attempts = attempts + 1,
          applied_at = timezone('utc', now())
      WHERE user_id = ${USERS.scale}
        AND status = 'pending'
    `;
    const allTurnKeys = Array.from(
      { length: turnCount },
      (_, index) => `memory_race_scale_assistant_${index}`,
    );
    await writeAtomic(
      chatFsPaths.relationship(USERS.scale, CHAR),
      renderRelationship(
        {
          stage: "committed",
          signals: {
            warmth: turnCount,
            familiarity: turnCount,
            turns: turnCount,
          },
          summary: allTurnKeys.slice(-8).join("\n"),
          version: turnCount,
        },
        allTurnKeys.slice(-256),
      ),
    );

    await deleteMessage(
      {
        userId: USERS.scale,
        messageId: "memory_race_scale_user_0",
      },
      prisma,
    );

    const state = await getRelationshipState(USERS.scale, CHAR);
    expect(state.signals).toEqual({
      warmth: 0,
      familiarity: 0,
      turns: 300,
    });
    const raw =
      (await readWhole(
        chatFsPaths.relationship(USERS.scale, CHAR),
      )) ?? "";
    const keys = JSON.parse(
      raw.match(/^applied_turn_keys:\s*(.+)$/m)?.[1] ?? "[]",
    ) as string[];
    expect(keys).toHaveLength(300);
    expect(keys).not.toContain("memory_race_scale_assistant_0");
    expect(keys).toContain("memory_race_scale_assistant_300");
    const payloads = await prisma.chatFileMutation.findMany({
      where: { userId: USERS.scale },
      select: { payload: true },
    });
    expect(JSON.stringify(payloads)).not.toContain("scale secret");
  });
});
