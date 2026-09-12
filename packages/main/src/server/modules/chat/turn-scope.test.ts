import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  CHAT_SCOPE_LOCK_ORDER,
  lockChatScope,
  type ChatScopeRequest,
} from "./turn-scope";
import {
  TOOL_EFFECT_ATTACHMENT_STATUSES,
  TOOL_EFFECT_ATTACHMENT_TRANSITIONS,
  abandonRequestedToolEffectAttachment,
  assertToolEffectAttachmentTransition,
  canTransitionToolEffectAttachment,
  createToolEffectAttachment,
  transitionToolEffectAttachment,
  type ToolEffectAttachmentStatus,
} from "./tool-effect-attachment";

// SPEC: 锁序和附件状态迁移在真 PostgreSQL 之外无处可验——这两条以前没有任何断言。
// 这里用一个记录调用序的 tx 替身，把「取锁顺序」和「合法/非法迁移集合」变成可跑的事实。

type Row = Record<string, unknown>;

type Fixture = {
  readonly users?: readonly Row[];
  readonly groups?: readonly Row[];
  readonly sessions?: readonly Row[];
  readonly turns?: readonly Row[];
  readonly attachments?: readonly Row[];
};

const TABLE = /FROM\s+"?([a-z_]+)"?/i;

function fakeTx(fixture: Fixture) {
  const locks: string[] = [];
  // 深拷贝：替身会就地改行，共享 fixture 会让上一条用例的写污染下一条。
  const copy = (rows: readonly Row[] | undefined): Row[] => structuredClone(rows ?? []) as Row[];
  const sessions = copy(fixture.sessions);
  const turns = copy(fixture.turns);
  const attachments = copy(fixture.attachments);
  const groups = copy(fixture.groups);

  // Prisma 的 where 在这里只需要支持本 module 真正用到的形状：标量相等，
  // 外加 session / turn 的一层关系下钻。多一分通用性都是负债。
  const sessionOf = (row: Row) => sessions.find((item) => item.sessionId === row.sessionId);
  const turnOf = (row: Row) => turns.find((item) => item.id === row.turnId);

  const matches = (row: Row, where: Row | undefined, relations: Record<string, (row: Row) => Row | undefined>): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, value]) => {
      if (value === undefined) return true;
      const resolve = relations[key];
      if (resolve) {
        const related = resolve(row);
        return related ? matches(related, value as Row, { session: sessionOf, turn: turnOf }) : false;
      }
      return row[key] === value;
    });
  };

  // Prisma 的 select 只被用来下钻关系，所以替身统一把关系挂满再返回一个副本，
  // 是真实返回的超集；存储行本身不带关系，断言里才不会撞上循环引用。
  const withTurn = (row: Row | undefined) =>
    row ? { ...row, session: sessionOf(row) } : null;
  const withAttachment = (row: Row | undefined) =>
    row ? { ...row, turn: withTurn(turnOf(row)) } : null;

  const client = {
    $queryRaw: (strings: TemplateStringsArray) => {
      const table = TABLE.exec(strings.join(" "))?.[1];
      if (table) locks.push(table);
      return Promise.resolve([]);
    },
    recentChat: {
      findFirst: ({ where }: { where?: Row }) =>
        Promise.resolve(sessions.find((row) => matches(row, where, {})) ?? null),
    },
    groupConversation: {
      findFirst: ({ where }: { where?: Row }) =>
        Promise.resolve(groups.find((row) => matches(row, where, {})) ?? null),
    },
    chatTurn: {
      findFirst: ({ where }: { where?: Row }) =>
        Promise.resolve(withTurn(turns.find((row) => matches(row, where, { session: sessionOf })))),
    },
    chatTurnAttachment: {
      findFirst: ({ where }: { where?: Row }) =>
        Promise.resolve(withAttachment(attachments.find((row) => matches(row, where, { turn: turnOf })))),
      create: ({ data }: { data: Row }) => {
        attachments.push({ ...data });
        return Promise.resolve({ ...data });
      },
      update: ({ where, data }: { where: Row; data: Row }) => {
        const row = attachments.find((item) => item.id === where.id);
        if (!row) throw new Error("no such attachment");
        Object.assign(row, data);
        return Promise.resolve({ ...row });
      },
      updateMany: ({ where, data }: { where: Row; data: Row }) => {
        const metadata = where.metadata as { path: string[]; equals: unknown } | undefined;
        const scalar = { ...where };
        delete scalar.metadata;
        const hit = attachments.filter((row) =>
          matches(row, scalar, {}) &&
          (!metadata || (row.metadata as Row | undefined)?.[metadata.path[0]] === metadata.equals));
        for (const row of hit) Object.assign(row, data);
        return Promise.resolve({ count: hit.length });
      },
    },
  };
  return { tx: client as unknown as Prisma.TransactionClient, locks, attachments };
}

const SOLO: Fixture = {
  sessions: [{ sessionId: "s1", userId: "u1", characterId: "c1", status: "active", groupId: null }],
  turns: [{ id: "t1", sessionId: "s1", attempt: 2, assistantStatus: "generating" }],
  attachments: [{ id: "a1", turnId: "t1", kind: "generated_image", status: "requesting", generationJobId: null, metadata: { attempt: 2 } }],
};

const GROUPED: Fixture = {
  groups: [{ id: "g1", userId: "u1", status: "active" }],
  sessions: [{ sessionId: "s1", userId: "u1", characterId: "c1", status: "active", groupId: "g1" }],
  turns: [{ id: "t1", sessionId: "s1", attempt: 1, assistantStatus: "sent" }],
  attachments: [{ id: "a1", turnId: "t1", kind: "generated_video", status: "accepted", generationJobId: "j1", metadata: { attempt: 1 } }],
};

async function lockOrder(fixture: Fixture, request: ChatScopeRequest) {
  const { tx, locks } = fakeTx(fixture);
  await lockChatScope(tx, request);
  return locks;
}

describe("chat scope lock ladder", () => {
  it("locks users → recent_chats → chat_turns → chat_turn_attachments from any anchor", async () => {
    // 同一条阶梯，三个不同入口，顺序不因入口而变。
    await expect(lockOrder(SOLO, { userId: "u1", at: { attachment: "a1" } })).resolves.toEqual([
      "users", "recent_chats", "chat_turns", "chat_turn_attachments",
    ]);
    await expect(lockOrder(SOLO, { userId: "u1", at: { turn: "t1" } })).resolves.toEqual([
      "users", "recent_chats", "chat_turns",
    ]);
    await expect(lockOrder(SOLO, { userId: "u1", at: { session: "s1" } })).resolves.toEqual([
      "users", "recent_chats",
    ]);
  });

  it("inserts group_conversations between users and recent_chats for a group session", async () => {
    await expect(lockOrder(GROUPED, { userId: "u1", at: { attachment: "a1" } })).resolves.toEqual([
      "users", "group_conversations", "recent_chats", "chat_turns", "chat_turn_attachments",
    ]);
  });

  it("never emits a lock outside the declared ladder, and never out of order", async () => {
    for (const fixture of [SOLO, GROUPED]) {
      for (const at of [{ attachment: "a1" }, { turn: "t1" }, { session: "s1" }]) {
        const locks = await lockOrder(fixture, { userId: "u1", at });
        const positions = locks.map((table) => CHAT_SCOPE_LOCK_ORDER.indexOf(table as never));
        expect(positions).not.toContain(-1);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        expect(new Set(locks).size).toBe(locks.length);
      }
    }
  });

  it("takes every lock before reading any row it returns", async () => {
    const { tx, locks } = fakeTx(SOLO);
    const reads: string[] = [];
    const observed = new Proxy(tx, {
      get(target, key: string) {
        const value = Reflect.get(target, key) as unknown;
        if (key === "$queryRaw" || typeof value !== "object" || value === null) return value;
        return new Proxy(value, {
          get(model, method: string) {
            const fn = Reflect.get(model, method) as (args: unknown) => unknown;
            if (typeof fn !== "function") return fn;
            return (args: unknown) => {
              reads.push(`${key}.${method}@${locks.length}`);
              return fn.call(model, args);
            };
          },
        });
      },
    });
    const scope = await lockChatScope(observed, { userId: "u1", at: { attachment: "a1" } });
    expect(scope.attachment?.id).toBe("a1");
    // 上锁前只有身份解析那一次读；返回值里的每一行都是四把锁到手之后读的。
    const afterLadder = reads.filter((entry) => entry.endsWith("@4"));
    expect(afterLadder).toEqual([
      "recentChat.findFirst",
      "chatTurn.findFirst",
      "chatTurnAttachment.findFirst",
    ].map((entry) => `${entry}@4`));
    expect(reads.filter((entry) => entry.endsWith("@0"))).toHaveLength(1);
  });

  it("rejects a Turn whose attempt or assistant status moved on", async () => {
    const { tx } = fakeTx(SOLO);
    await expect(lockChatScope(tx, { userId: "u1", at: { turn: "t1" }, expect: { attempt: 1 } }))
      .rejects.toThrow(/another attempt/);
    await expect(lockChatScope(tx, { userId: "u1", at: { turn: "t1" }, expect: { assistantStatus: ["sent"] } }))
      .rejects.toThrow(/expected state/);
  });

  it("rejects an attachment left behind by a discarded attempt", async () => {
    const stale: Fixture = {
      ...SOLO,
      attachments: [{ ...(SOLO.attachments ?? [])[0], metadata: { attempt: 1 } }],
    };
    const { tx } = fakeTx(stale);
    await expect(lockChatScope(tx, {
      userId: "u1",
      at: { attachment: "a1" },
      expect: { attachmentAttemptMatchesTurn: true },
    })).rejects.toThrow(/discarded attempt/);
  });

  it("refuses another account's rows and a session pinned to another character", async () => {
    const { tx } = fakeTx(SOLO);
    await expect(lockChatScope(tx, { userId: "u2", at: { attachment: "a1" } })).rejects.toThrow();
    await expect(lockChatScope(tx, { userId: "u1", at: { turn: "t1" }, expect: { characterId: "c2" } }))
      .rejects.toThrow(/original character/);
  });
});

describe("tool effect attachment state machine", () => {
  const legal: Readonly<Record<ToolEffectAttachmentStatus, readonly ToolEffectAttachmentStatus[]>> = {
    requesting: ["accepted", "failed"],
    accepted: ["completed", "failed", "blocked", "refunded", "cancelled"],
    completed: [],
    failed: ["accepted"],
    refunded: ["accepted"],
    blocked: [],
    cancelled: [],
  };

  it("permits exactly the declared edges and nothing else", () => {
    for (const from of TOOL_EFFECT_ATTACHMENT_STATUSES) {
      for (const to of TOOL_EFFECT_ATTACHMENT_STATUSES) {
        // 同名重放是幂等，不是迁移。
        const expected = from === to || legal[from].includes(to);
        expect({ from, to, allowed: canTransitionToolEffectAttachment(from, to) })
          .toEqual({ from, to, allowed: expected });
      }
    }
    expect(TOOL_EFFECT_ATTACHMENT_TRANSITIONS).toEqual(legal);
  });

  it("fails closed on an unknown persisted status", () => {
    expect(canTransitionToolEffectAttachment("deleted", "failed")).toBe(false);
    expect(() => assertToolEffectAttachmentTransition("deleted", "failed")).toThrow();
  });

  it("refuses the illegal jumps that used to be expressible", async () => {
    const { tx } = fakeTx(SOLO);
    const scope = await lockChatScope(tx, { userId: "u1", at: { attachment: "a1" } });
    // requesting 直接跳交付：以前任何一个写入方都写得出来。
    await expect(transitionToolEffectAttachment(tx, scope.attachment!, { to: "completed" }))
      .rejects.toThrow(/can no longer change/);
    const grouped = fakeTx(GROUPED);
    const done = await lockChatScope(grouped.tx, { userId: "u1", at: { attachment: "a1" } });
    await transitionToolEffectAttachment(grouped.tx, done.attachment!, { to: "completed", mediaAssetId: "m1" });
    const settled = await lockChatScope(grouped.tx, { userId: "u1", at: { attachment: "a1" } });
    await expect(transitionToolEffectAttachment(grouped.tx, settled.attachment!, { to: "cancelled" }))
      .rejects.toThrow(/can no longer change/);
  });

  it("accepts a reserved effect and lets a failed one be retried onto the same identity", async () => {
    const { tx, attachments } = fakeTx(SOLO);
    const scope = await lockChatScope(tx, { userId: "u1", at: { attachment: "a1" } });
    await transitionToolEffectAttachment(tx, scope.attachment!, { to: "accepted", generationJobId: "j9" });
    expect(attachments[0]).toMatchObject({ status: "accepted", generationJobId: "j9" });
    const accepted = await lockChatScope(tx, { userId: "u1", at: { attachment: "a1" } });
    await transitionToolEffectAttachment(tx, accepted.attachment!, { to: "failed", errorCode: "provider_failed" });
    const failed = await lockChatScope(tx, { userId: "u1", at: { attachment: "a1" } });
    await transitionToolEffectAttachment(tx, failed.attachment!, { to: "accepted", generationJobId: "j10" });
    expect(attachments[0]).toMatchObject({ status: "accepted", generationJobId: "j10" });
  });

  it("is born requesting with its attempt written by the single creation entry", async () => {
    const { tx, attachments } = fakeTx(SOLO);
    const scope = await lockChatScope(tx, { userId: "u1", at: { turn: "t1" } });
    const created = await createToolEffectAttachment(tx, {
      id: "a2",
      turn: scope.turn!,
      kind: "generated_video",
      attempt: 2,
      metadata: { sourceMediaId: "m1" },
    });
    expect(created).toMatchObject({ status: "requesting", kind: "generated_video" });
    expect(attachments.find((row) => row.id === "a2")?.metadata)
      .toEqual({ sourceMediaId: "m1", attempt: 2 });
    await expect(createToolEffectAttachment(tx, {
      id: "a3", turn: scope.turn!, kind: "generated_image", attempt: 1,
    })).rejects.toThrow(/active Chat attempt/);
  });

  it("abandons a reservation only while it is still requesting and unbound", async () => {
    const { tx, attachments } = fakeTx(SOLO);
    await expect(abandonRequestedToolEffectAttachment(tx, { id: "a1", attempt: 1, errorCode: "x" })).resolves.toBe(false);
    await expect(abandonRequestedToolEffectAttachment(tx, { id: "a1", attempt: 2, errorCode: "x" })).resolves.toBe(true);
    expect(attachments[0]).toMatchObject({ status: "failed", errorCode: "x" });
    await expect(abandonRequestedToolEffectAttachment(tx, { id: "a1", attempt: 2, errorCode: "y" })).resolves.toBe(false);
  });
});

// SPEC: 产品 Turn 的锁序权威是 turn-scope.ts。这张台账记录「还有谁自带一份裸锁」，
// 集合相等——新增一处会失败，搬走一处也会失败，所以它不会烂在这里。
//
// INTENT: 一次性把 turn-ledger.ts 的 11 条裸锁搬进阶梯不安全：那些调用点在
// recent_chats 与 chat_turns 之间还夹着 archived 判定和 companion memory rebuild
// 断言，改动顺序需要真 PostgreSQL 才能验。台账先把剩余面暴露成可数的事实。
describe("chat lock ladder inventory", () => {
  const CHAT_LOCK_TABLES = ["recent_chats", "chat_turns", "chat_turn_attachments", "group_conversations"];
  const REMAINING_BARE_LOCKS: Readonly<Record<string, number>> = {
    // 阶梯权威本体。
    "modules/chat/turn-scope.ts": 4,
    "modules/chat/turn-ledger.ts": 11,
    "modules/chat/group-conversations.ts": 1,
    "modules/chat/tool-effect.ts": 1,
  };

  it("keeps every bare chat-table lock inside the declared inventory", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.join(process.cwd(), "src/server");
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const nested = await Promise.all(entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) return [];
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
      }));
      return nested.flat();
    };
    const found: Record<string, number> = {};
    for (const file of await walk(root)) {
      const source = await readFile(file, "utf8");
      const count = source
        .split("\n")
        .filter((line) => line.includes("FOR UPDATE") && CHAT_LOCK_TABLES.some((table) => line.includes(table)))
        .length;
      if (count > 0) found[path.relative(path.join(process.cwd(), "src/server"), file)] = count;
    }
    expect(found).toEqual(REMAINING_BARE_LOCKS);
  });

  // SPEC: 附件状态的写入口台账。边界内只剩 tool-effect-attachment.ts 一处；
  // 剩下两个文件在本次任务的文件边界外（只读），列在这里是为了让它们可数、可跟踪。
  it("keeps every attachment status write inside the declared inventory", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.join(process.cwd(), "src/server");
    const declared = [
      "modules/chat/tool-effect-attachment.ts",
      "ai/local-pipeline.ts",
      "modules/admin-v2/jobs/unknown-reconciliation.ts",
    ].sort();
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const nested = await Promise.all(entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) return [];
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
      }));
      return nested.flat();
    };
    const writers: string[] = [];
    const delegate = ["chatTurnAttachment", ".", "update"].join("");
    for (const file of await walk(root)) {
      const source = await readFile(file, "utf8");
      const lines = source.split("\n");
      const writes = lines.some((line, index) => {
        if (!line.includes(delegate) && !line.includes(["chatTurnAttachment", ".create"].join(""))) return false;
        return lines.slice(index, index + 12).some((body) => /\bstatus:\s*["'`]|\bstatus,/.test(body));
      });
      if (writes) writers.push(path.relative(root, file));
    }
    expect(writers.sort()).toEqual(declared);
  });
});
