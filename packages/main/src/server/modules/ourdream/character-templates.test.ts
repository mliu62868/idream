import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { handle } from "@/server/lib/http";
import { listActiveTemplates } from "./character-templates";

// SPEC: 前台公开只读模板投影的契约测试。
// INTENT: 直接用 prisma 造数据，不经 admin 写路径 —— 这条路由的正确性不该依赖
//         admin 模块，测试也不该。它测两件事：可见性过滤 + select 白名单。

const P = "zt-pubtmpl-";

async function purge() {
  await prisma.characterTemplate.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(purge);
afterAll(async () => {
  await purge();
  await prisma.$disconnect();
});

async function seedTemplate(input: { id: string; name: string; isActive: boolean; sortOrder: number }) {
  await prisma.characterTemplate.create({
    data: {
      id: `${P}${input.id}`,
      scope: "built_in",
      name: input.name,
      summary: "seeded",
      appearance: {},
      advancedDetails: {},
      tags: [],
      sortOrder: input.sortOrder,
      isActive: input.isActive,
    },
  });
}

async function callPublicRoute() {
  const response = await handle(() => listActiveTemplates())(
    new Request("http://localhost/api/v1/character-templates"),
  );
  const json = (await response.json()) as {
    ok: boolean;
    data: { items: { id: string; name: string }[] };
  };
  return { status: response.status, items: json.data.items };
}

describe("public character template projection", () => {
  it("returns only active templates, ordered by sortOrder, without admin identity", async () => {
    await seedTemplate({ id: "visible-late", name: "Visible Late", isActive: true, sortOrder: 5 });
    await seedTemplate({ id: "visible-early", name: "Visible Early", isActive: true, sortOrder: 1 });
    await seedTemplate({ id: "hidden", name: "Hidden One", isActive: false, sortOrder: 0 });

    const result = await callPublicRoute();
    expect(result.status).toBe(200);

    const seeded = result.items.filter((item) => item.id.startsWith(P));
    expect(seeded.map((item) => item.name)).toEqual(["Visible Early", "Visible Late"]);
    expect(seeded.map((item) => item.name)).not.toContain("Hidden One");
  });

  it("does not leak internal fields through the select whitelist", async () => {
    await seedTemplate({ id: "leak-check", name: "Leak Check", isActive: true, sortOrder: 9 });

    const result = await callPublicRoute();
    const visible = result.items.find((item) => item.id === `${P}leak-check`);
    expect(visible).toBeDefined();
    expect(visible).not.toHaveProperty("createdById");
    expect(visible).not.toHaveProperty("isActive");
    expect(visible).not.toHaveProperty("scope");
  });
});
