// SPEC: 官方角色 CMS 服务层回归（Feature A）。直接调用 handler（dispatch 由编排者统一接线），
//       覆盖：权限 403、创建成功 source=official+status=approved、age<18 zod 拒、moderation blocked→403、
//       update 非 official 角色 404。
// INVARIANTS: dev auth headers（x-idream-user-id/role）仅因 APP_ENV=test 生效。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import {
  createOfficialCharacter,
  listOfficialCharacters,
  setOfficialState,
  updateOfficialCharacter,
} from "./official";

const P = "zt-official-";

type CallResult = {
  status: number;
  ok: boolean;
  data: Record<string, unknown> | undefined;
  errorCode: string | undefined;
};

function makeRequest(
  method: string,
  path: string,
  opts: { userId: string; role: string; body?: unknown },
): Request {
  const headers: Record<string, string> = {
    "x-idream-user-id": opts.userId,
    "x-idream-role": opts.role,
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost/api/v1/admin/content/official${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// 直调 handler：成功回 Response，失败抛 AppError/ZodError —— 统一归一成 CallResult。
async function call(handler: Promise<Response>): Promise<CallResult> {
  try {
    const res = await handler;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as { ok?: boolean; data?: Record<string, unknown> }) : null;
    return { status: res.status, ok: Boolean(json?.ok), data: json?.data, errorCode: undefined };
  } catch (error) {
    if (error instanceof AppError) {
      return { status: error.status, ok: false, data: undefined, errorCode: error.code };
    }
    if (error instanceof ZodError) {
      return { status: 400, ok: false, data: undefined, errorCode: "bad_request" };
    }
    throw error;
  }
}

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

async function seedActor(role: "admin" | "ops", suffix: string) {
  const id = `${P}${role}-${suffix}`;
  await createUser({ id, role });
  return id;
}

describe("official character CMS", () => {
  it("gates every handler behind content.official.write (403 for ops)", async () => {
    const ops = await seedActor("ops", "gate");
    const result = await call(
      createOfficialCharacter(
        makeRequest("POST", "", {
          userId: ops,
          role: "ops",
          body: {
            name: `${P}Nope`,
            age: 24,
            gender: "female",
            style: "realistic",
            description: "should not be created",
            reason: "blocked by permission",
          },
        }),
      ),
    );
    expect(result.status).toBe(403);
    expect(result.errorCode).toBe("forbidden");

    const listResult = await call(
      listOfficialCharacters(makeRequest("GET", "", { userId: ops, role: "ops" })),
    );
    expect(listResult.status).toBe(403);
  });

  it("creates an official character as approved/public with source=official", async () => {
    const admin = await seedActor("admin", "create");
    const result = await call(
      createOfficialCharacter(
        makeRequest("POST", "", {
          userId: admin,
          role: "admin",
          body: {
            name: `${P}Aria`,
            age: 27,
            gender: "female",
            style: "anime",
            description: "A cheerful official companion.",
            tags: ["Bubbly", "Bubbly", "Sci Fi"],
            reason: "seed official roster",
          },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    const character = result.data?.character as {
      id: string;
      source: string;
      status: string;
      visibility: string;
      systemPrompt: string | null;
      tags: { tag: { slug: string } }[];
    };
    expect(character.source).toBe("official");
    expect(character.status).toBe("approved");
    expect(character.visibility).toBe("public");
    expect(character.systemPrompt).toBeTruthy();
    // 去重 + slug：Bubbly 只连一次，"Sci Fi" → "sci-fi"。
    const slugs = character.tags.map((t) => t.tag.slug).sort();
    expect(slugs).toEqual(["bubbly", "sci-fi"]);

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.official.create", targetId: character.id },
    });
    expect(audit).not.toBeNull();

    // 出现在 list 中。
    const listResult = await call(
      listOfficialCharacters(
        makeRequest("GET", "?search=Aria", { userId: admin, role: "admin" }),
      ),
    );
    const items = (listResult.data?.items ?? []) as { id: string }[];
    expect(items.some((c) => c.id === character.id)).toBe(true);
  });

  it("rejects age < 18 at the zod boundary (400)", async () => {
    const admin = await seedActor("admin", "underage");
    const result = await call(
      createOfficialCharacter(
        makeRequest("POST", "", {
          userId: admin,
          role: "admin",
          body: {
            name: `${P}TooYoung`,
            age: 17,
            gender: "female",
            style: "realistic",
            description: "must be rejected",
            reason: "age boundary",
          },
        }),
      ),
    );
    expect(result.status).toBe(400);
    expect(result.errorCode).toBe("bad_request");
  });

  it("blocks moderation-flagged content (403)", async () => {
    const admin = await seedActor("admin", "moderation");
    const result = await call(
      createOfficialCharacter(
        makeRequest("POST", "", {
          userId: admin,
          role: "admin",
          body: {
            name: `${P}Bad`,
            age: 24,
            gender: "female",
            style: "realistic",
            // mock moderation 命中 "underage" 关键词 → blocked。
            description: "this description references underage content",
            reason: "should be blocked",
          },
        }),
      ),
    );
    expect(result.status).toBe(403);
    expect(result.errorCode).toBe("forbidden");
  });

  it("returns 404 when updating a non-official (user) character", async () => {
    const admin = await seedActor("admin", "update404");
    const userChar = `${P}user-char`;
    await createCharacter({ id: userChar, name: "User Character", visibility: "public", status: "approved" });

    const result = await call(
      updateOfficialCharacter(
        makeRequest("PATCH", `/${userChar}`, {
          userId: admin,
          role: "admin",
          body: { description: "trying to hijack a user character", reason: "should 404" },
        }),
        userChar,
      ),
    );
    expect(result.status).toBe(404);
    expect(result.errorCode).toBe("not_found");

    // setState 同样 404。
    const stateResult = await call(
      setOfficialState(
        makeRequest("POST", `/${userChar}/state`, {
          userId: admin,
          role: "admin",
          body: { status: "archived", reason: "should 404" },
        }),
        userChar,
      ),
    );
    expect(stateResult.status).toBe(404);
  });

  it("archives then re-publishes an official character and audits each transition", async () => {
    const admin = await seedActor("admin", "publish");
    const created = await call(
      createOfficialCharacter(
        makeRequest("POST", "", {
          userId: admin,
          role: "admin",
          body: {
            name: `${P}Toggle`,
            age: 26,
            gender: "female",
            style: "realistic",
            description: "An official companion used to verify publish/archive.",
            reason: "seed for state toggle",
          },
        }),
      ),
    );
    const id = (created.data?.character as { id: string }).id;

    // approved -> archived (disappears from public feed)
    const archived = await call(
      setOfficialState(
        makeRequest("POST", `/${id}/state`, {
          userId: admin,
          role: "admin",
          body: { status: "archived", reason: "take offline for QA" },
        }),
        id,
      ),
    );
    expect(archived.ok).toBe(true);
    expect((archived.data?.character as { status: string }).status).toBe("archived");

    // archived -> approved (back live)
    const republished = await call(
      setOfficialState(
        makeRequest("POST", `/${id}/state`, {
          userId: admin,
          role: "admin",
          body: { status: "approved", reason: "bring back live" },
        }),
        id,
      ),
    );
    expect(republished.ok).toBe(true);
    expect((republished.data?.character as { status: string }).status).toBe("approved");

    const audits = await prisma.adminAuditLog.count({
      where: { action: "content.official.publish", targetId: id },
    });
    expect(audits).toBe(2);
  });
});
