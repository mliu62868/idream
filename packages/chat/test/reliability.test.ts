// P0-4 + P0-5 acceptance: inbox idempotency, reconcile convergence, maintain
// rolling/TTL, privacy deletion across PG + files.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createChatPrisma } from "../src/db.js";
import { consumeInbound, reprocessPendingInbox } from "../src/inbox.js";
import { reconcile } from "../src/reconcile.js";
import { rollSessionLog, pruneExpiredSegments } from "../src/maintain.js";
import { deleteSession, deleteAccount } from "../src/privacy.js";
import { appendLine, chatFsPaths, listPrefix } from "../src/chat-fs.js";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";

const prisma = createChatPrisma();
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
let fsRoot: string;
const USER = "u_rel";
const CHAR = "c_rel";

beforeAll(async () => {
  fsRoot = await mkdtemp(path.join(tmpdir(), "chat-rel-"));
  process.env.CHAT_FS_ROOT = fsRoot;
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [USER, "rel@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.characters (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'Rel',24,'d','public','approved','realistic','female','{}','{}',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [CHAR],
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await superPool.end();
  await rm(fsRoot, { recursive: true, force: true });
});

describe("inbox (P0-4 main→chat, idempotent)", () => {
  it("character.removed archives active sessions; re-consume is a no-op", async () => {
    const s = await prisma.chatSession.create({
      data: { id: "rel_s1", userId: USER, characterId: CHAR, status: "active" },
    });
    const event = {
      eventId: "rel_evt_1",
      eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
      payload: { characterId: CHAR },
    };
    const first = await consumeInbound(event, prisma);
    expect(first.applied).toBe(true);
    expect((await prisma.chatSession.findUnique({ where: { id: s.id } }))?.status).toBe("archived");

    const second = await consumeInbound(event, prisma);
    expect(second.applied).toBe(false); // idempotent on eventId
  });
});

describe("reconcile (P0-4 convergence)", () => {
  it("marks long-stuck generating messages failed", async () => {
    const s = await prisma.chatSession.create({
      data: { id: "rel_s2", userId: USER, characterId: CHAR, status: "active" },
    });
    await prisma.message.create({
      data: { id: "rel_m_stuck", sessionId: s.id, role: "assistant", status: "generating", attempt: 1 },
    });
    // force updatedAt into the past via raw SQL (chat_service can update chat.*)
    // chat.* timestamps are naive-UTC (match Prisma's DateTime); use UTC here too.
    await prisma.$executeRawUnsafe(
      `UPDATE chat.messages SET updated_at = timezone('utc', now()) - interval '10 minutes' WHERE id = 'rel_m_stuck'`,
    );
    const result = await reconcile(prisma);
    expect(result.failedStuck).toBeGreaterThanOrEqual(1);
    expect((await prisma.message.findUnique({ where: { id: "rel_m_stuck" } }))?.status).toBe("failed");
  });
});

describe("maintain (P0-5 rolling/TTL)", () => {
  it("rolls the active jsonl when over the size threshold", async () => {
    const p = chatFsPaths.sessionLog(USER, "rel_roll");
    await appendLine(p, "x".repeat(2000));
    const rolled = await rollSessionLog(USER, "rel_roll", 100);
    expect(rolled).toBe(true);
    const files = await readdir(path.join(fsRoot, "sessions", USER));
    expect(files.some((f) => /^rel_roll\.\d+\.jsonl$/.test(f))).toBe(true);
  });

  it("prunes segments older than the TTL", async () => {
    const dir = path.join(fsRoot, "sessions", USER);
    await mkdir(dir, { recursive: true });
    const seg = path.join(dir, "rel_old.1.jsonl");
    await writeFile(seg, "old");
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await utimes(seg, old, old);
    const removed = await pruneExpiredSegments(180 * 24 * 60 * 60 * 1000);
    expect(removed).toBeGreaterThanOrEqual(1);
  });
});

describe("privacy deletion (P0-5, PG + files)", () => {
  it("deleteSession removes messages + jsonl", async () => {
    const s = await prisma.chatSession.create({
      data: { id: "rel_del", userId: USER, characterId: CHAR, status: "active" },
    });
    await prisma.message.create({ data: { id: "rel_del_m", sessionId: s.id, role: "user", content: "hi", status: "sent" } });
    await appendLine(chatFsPaths.sessionLog(USER, s.id), JSON.stringify({ k: 1 }));

    await deleteSession({ userId: USER, sessionId: s.id }, prisma);

    expect(await prisma.message.findUnique({ where: { id: "rel_del_m" } })).toBeNull();
    expect((await prisma.chatSession.findUnique({ where: { id: s.id } }))?.status).toBe("deleted");
    const files = await readdir(path.join(fsRoot, "sessions", USER)).catch(() => []);
    expect(files).not.toContain(`${s.id}.jsonl`);
  });

  it("deleteAccount wipes chat rows + both file prefixes + emits erasure", async () => {
    const u = "u_erase";
    await superPool.query(
      `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
      [u, "erase@test.dev"],
    );
    const s = await prisma.chatSession.create({ data: { id: "erase_s", userId: u, characterId: CHAR, status: "active" } });
    await prisma.message.create({ data: { id: "erase_m", sessionId: s.id, role: "user", content: "x", status: "sent" } });
    await appendLine(chatFsPaths.sessionLog(u, s.id), "{}");
    await writeFile(path.join(fsRoot, "mem", u, "global", "boundaries.md"), "b").catch(async () => {
      await mkdir(path.join(fsRoot, "mem", u, "global"), { recursive: true });
      await writeFile(path.join(fsRoot, "mem", u, "global", "boundaries.md"), "b");
    });

    await deleteAccount({ userId: u }, prisma);

    expect(await prisma.chatSession.findMany({ where: { userId: u } })).toEqual([]);
    expect(await listPrefix(["sessions", u])).toEqual([]);
    expect(await listPrefix(["mem", u])).toEqual([]);
    const erasure = await prisma.chatOutboxEvent.findFirst({
      where: { aggregateId: u, eventType: "chat.account_erasure.completed" },
    });
    expect(erasure).not.toBeNull();
  });
});
