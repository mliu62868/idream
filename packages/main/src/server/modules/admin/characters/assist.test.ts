// SPEC: AI 辅助生成服务层回归（§8 增强）。直接调用 handler（dispatch 由编排者接线）。
//       覆盖：成功返回非空 description+personality、权限 403、seed 过短 zod 拒、moderation blocked→403。
// INVARIANTS: 用 mock chat provider（确定性输出）+ mock moderation（underage 关键词拦截）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { createUser, purgeTestData } from "@/server/test/helpers";
import { generateCharacterDraft } from "./assist";

const P = "zt-assist-";

type CallResult = {
  status: number;
  ok: boolean;
  data: { description?: string; advancedDetails?: { personality?: string } } | undefined;
  errorCode: string | undefined;
};

function makeRequest(opts: { userId: string; role: string; body: unknown }): Request {
  return new Request("http://localhost/api/v1/admin/content/character-assist", {
    method: "POST",
    headers: {
      "x-idream-user-id": opts.userId,
      "x-idream-role": opts.role,
      "content-type": "application/json",
    },
    body: JSON.stringify(opts.body),
  });
}

async function call(handler: Promise<Response>): Promise<CallResult> {
  try {
    const res = await handler;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as { ok?: boolean; data?: CallResult["data"] }) : null;
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
  await createUser({ id: `${P}admin`, role: "admin" });
  await createUser({ id: `${P}ops`, role: "ops" });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("character AI assist", () => {
  it("returns non-empty description + personality for an admin", async () => {
    const result = await call(
      generateCharacterDraft(
        makeRequest({
          userId: `${P}admin`,
          role: "admin",
          body: { seed: "shy bookish painter who loves rainy nights", gender: "female", style: "realistic" },
        }),
      ),
    );
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect((result.data?.description ?? "").length).toBeGreaterThan(0);
    expect((result.data?.advancedDetails?.personality ?? "").length).toBeGreaterThan(0);
  });

  it("rejects roles without content.official.write (403)", async () => {
    const result = await call(
      generateCharacterDraft(
        makeRequest({ userId: `${P}ops`, role: "ops", body: { seed: "a cheerful barista" } }),
      ),
    );
    expect(result.status).toBe(403);
    expect(result.ok).toBe(false);
  });

  it("rejects a too-short seed (zod 400)", async () => {
    const result = await call(
      generateCharacterDraft(makeRequest({ userId: `${P}admin`, role: "admin", body: { seed: "x" } })),
    );
    expect(result.status).toBe(400);
  });

  it("blocks underage seeds via moderation (403)", async () => {
    const result = await call(
      generateCharacterDraft(
        makeRequest({ userId: `${P}admin`, role: "admin", body: { seed: "an underage minor character" } }),
      ),
    );
    expect(result.status).toBe(403);
    expect(result.ok).toBe(false);
  });
});
