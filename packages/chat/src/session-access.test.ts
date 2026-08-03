import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { chatPrisma } from "./db.js";
import { ChatError } from "./errors.js";
import { archiveSession, getSession, renameSession } from "./service.js";
import {
  assertSessionAccess,
  lifecycleOf,
  type SessionDenial,
  type SessionLifecycle,
  type SessionRequirement,
} from "./session-access.js";

// SPEC: 访问前置条件的判定表。
// INTENT: 用**全矩阵**而不是挑几个样例 —— 这条规则此前手抄了十遍并且抄歪了三处，
//   而歪掉的那几处正是没人写样例的格子。矩阵的类型是 Record<Requirement, Record<
//   Lifecycle, boolean>>，所以将来任何人给 SessionRequirement 或 SessionLifecycle
//   加一个变体，这里会**编译不过**，而不是静静地少测一格。
const ALLOWS: Record<SessionRequirement, Record<SessionLifecycle, boolean>> = {
  active: { active: true, archived: false, deleted: false },
  not_deleted: { active: true, archived: true, deleted: false },
  any: { active: true, archived: true, deleted: true },
};

const LIFECYCLE_ROWS: Record<SessionLifecycle, { status: string; deletedAt: Date | null }> = {
  active: { status: "active", deletedAt: null },
  archived: { status: "archived", deletedAt: null },
  deleted: { status: "deleted", deletedAt: new Date("2026-01-01T00:00:00.000Z") },
};

function sessionRow(lifecycle: SessionLifecycle, userId: string) {
  return { id: "s", userId, ...LIFECYCLE_ROWS[lifecycle] } as never;
}

function denialOf(fn: () => void) {
  try {
    fn();
  } catch (error) {
    if (error instanceof ChatError) return { code: error.code, status: error.status };
    throw error;
  }
  return null;
}

describe("session-access 判定表", () => {
  it("lifecycleOf: status 与 deletedAt 任一说已删就是已删", () => {
    expect(lifecycleOf({ status: "active", deletedAt: null })).toBe("active");
    expect(lifecycleOf({ status: "archived", deletedAt: null })).toBe("archived");
    expect(lifecycleOf({ status: "deleted", deletedAt: null })).toBe("deleted");
    // 半写状态：今天没有写入方能产生它（privacy.ts 两个字段同事务写），但读侧
    // 不靠这个约定活着 —— 只写了 deletedAt 也必须判为已删。
    expect(lifecycleOf({ status: "active", deletedAt: new Date() })).toBe("deleted");
    expect(lifecycleOf({ status: "archived", deletedAt: new Date() })).toBe("deleted");
  });

  for (const requirement of Object.keys(ALLOWS) as SessionRequirement[]) {
    for (const lifecycle of Object.keys(ALLOWS[requirement]) as SessionLifecycle[]) {
      const allowed = ALLOWS[requirement][lifecycle];
      it(`require=${requirement} × ${lifecycle} → ${allowed ? "放行" : "拒绝"}`, () => {
        const denial = denialOf(() =>
          assertSessionAccess(sessionRow(lifecycle, "u1"), { userId: "u1" }, {
            require: requirement,
            denial: { kind: "not_found" },
          }),
        );
        expect(denial).toEqual(allowed ? null : { code: "session_not_found", status: 404 });
      });
    }
  }
});

describe("session-access 三种拒绝映射", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly denial: SessionDenial;
    /** 会话不存在或不属于调用方。 */
    readonly missing: { code: string; status: number };
    /** 会话是你的，但生命周期不满足。 */
    readonly lifecycle: { code: string; status: number };
  }> = [
    {
      // 入参是 sessionId：不区分"不存在"与"不是你的"，两者都 404。
      name: "not_found",
      denial: { kind: "not_found" },
      missing: { code: "session_not_found", status: 404 },
      lifecycle: { code: "session_not_found", status: 404 },
    },
    {
      // 入参是 messageId：存在性已由消息查询泄漏，归属 403、生命周期 409。
      name: "owner_forbidden",
      denial: { kind: "owner_forbidden", forbiddenMessage: "not your message" },
      missing: { code: "forbidden", status: 403 },
      lifecycle: { code: "session_not_active", status: 409 },
    },
    {
      // 事务内复查：外层已放行，此处一律并发冲突 409。
      name: "conflict",
      denial: { kind: "conflict" },
      missing: { code: "session_not_active", status: 409 },
      lifecycle: { code: "session_not_active", status: 409 },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: 归属失败 → ${testCase.missing.status}，生命周期失败 → ${testCase.lifecycle.status}`, () => {
      const policy = { require: "active" as const, denial: testCase.denial };
      expect(
        denialOf(() => assertSessionAccess(null, { userId: "u1" }, policy)),
      ).toEqual(testCase.missing);
      expect(
        denialOf(() =>
          assertSessionAccess(sessionRow("active", "someone-else"), { userId: "u1" }, policy),
        ),
      ).toEqual(testCase.missing);
      expect(
        denialOf(() =>
          assertSessionAccess(sessionRow("archived", "u1"), { userId: "u1" }, policy),
        ),
      ).toEqual(testCase.lifecycle);
    });
  }
});

// REGRESSION: 被擦除的会话必须是终态。archiveSession 此前只查归属不查生命周期，于是
// 客户端拿着一个陈旧 sessionId 调 archive，就能把 status 从 "deleted" 翻成 "archived"；
// listSessions 只按 status 过滤，那个已被擦除的会话就带着空消息列表重新出现在抽屉里。
const P = "zt-sacc-";
const OWNER = `${P}u1`;
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });

async function purge() {
  await chatPrisma.chatSession.deleteMany({ where: { id: { startsWith: P } } });
  await superPool.query(`DELETE FROM public.users WHERE id LIKE $1`, [`${P}%`]);
}

describe("擦除是终态", () => {
  beforeAll(async () => {
    await purge();
    await superPool.query(
      `INSERT INTO public.users (id,email,status,"createdAt","updatedAt")
       VALUES ($1,$2,'active',now(),now())`,
      [OWNER, `${OWNER}@session-access.test`],
    );
    await chatPrisma.chatSession.create({
      data: {
        id: `${P}erased`,
        userId: OWNER,
        characterId: `${P}c1`,
        status: "deleted",
        deletedAt: new Date(),
      },
    });
    await chatPrisma.chatSession.create({
      data: { id: `${P}archived`, userId: OWNER, characterId: `${P}c2`, status: "archived" },
    });
  });

  afterAll(async () => {
    await purge();
    await superPool.end();
  });

  it("archive 一个已擦除的会话被拒，且不会把它翻回 archived", async () => {
    await expect(
      archiveSession({ userId: OWNER, sessionId: `${P}erased` }),
    ).rejects.toMatchObject({ code: "session_not_found", status: 404 });
    const after = await chatPrisma.chatSession.findUnique({ where: { id: `${P}erased` } });
    expect(after?.status).toBe("deleted");
  });

  it("rename / getSession 同样看不见已擦除的会话", async () => {
    await expect(
      renameSession({ userId: OWNER, sessionId: `${P}erased`, title: "回来吧" }),
    ).rejects.toMatchObject({ code: "session_not_found", status: 404 });
    await expect(
      getSession({ userId: OWNER, sessionId: `${P}erased` }),
    ).rejects.toMatchObject({ code: "session_not_found", status: 404 });
  });

  it("已归档（非擦除）的会话仍然可以 archive 和改名 —— 没有误伤", async () => {
    await expect(
      archiveSession({ userId: OWNER, sessionId: `${P}archived` }),
    ).resolves.toMatchObject({ status: "archived" });
    await expect(
      renameSession({ userId: OWNER, sessionId: `${P}archived`, title: "新标题" }),
    ).resolves.toMatchObject({ title: "新标题" });
  });
});
