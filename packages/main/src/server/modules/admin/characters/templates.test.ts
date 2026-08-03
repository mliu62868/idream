import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { handle } from "@/server/lib/http";
import { createUser } from "@/server/test/helpers";
import {
  createTemplate,
  listTemplates,
  setTemplateActive,
  updateTemplate,
} from "./templates";

// SPEC: 特性 B 模板库 service 单测。dispatch 由编排者接线，这里直接调 handler。
// INVARIANTS: 用 dev auth header（APP_ENV=test 才生效）模拟不同 role 的权限；
//             handle() 把 handler 抛出的 AppError 归一为 ok/error 信封。

const P = "zt-tmpl-";

// 这些模型 purgeTestData 不覆盖（新表），自己按前缀清理。
async function purge() {
  await prisma.characterTemplate.deleteMany({
    where: { OR: [{ id: { startsWith: P } }, { createdById: { startsWith: P } }] },
  });
  await prisma.adminAuditLog.deleteMany({
    where: { OR: [{ actorId: { startsWith: P } }, { targetType: "character_template" }] },
  });
  await prisma.moderationEvent.deleteMany({ where: { targetType: "character_template" } });
  await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(purge);
afterAll(async () => {
  await purge();
  await prisma.$disconnect();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { status: number; ok: boolean; data: any; code?: string };

// 直接驱动 handler；handle() 包裹后抛错也变成 fail 信封，便于断言 status/code。
async function call(
  handler: (request: Request) => Promise<Response>,
  options: { method?: string; userId?: string; role?: string; body?: unknown } = {},
): Promise<Envelope> {
  const headers: Record<string, string> = {};
  if (options.userId) headers["x-idream-user-id"] = options.userId;
  if (options.role) headers["x-idream-role"] = options.role;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const request = new Request("http://localhost/api/v1/test", {
    method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const response = await handle(handler)(request);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return { status: response.status, ok: Boolean(json?.ok), data: json?.data, code: json?.error?.code };
}

async function setupAdmin(suffix: string) {
  const id = `${P}admin-${suffix}`;
  await createUser({ id, role: "admin" });
  return id;
}

describe("character template library service (feature B)", () => {
  it("creates an inactive built-in draft, stamps createdById + audit", async () => {
    const admin = await setupAdmin("create");
    const result = await call(createTemplate, {
      userId: admin,
      role: "admin",
      body: {
        name: "Cyber Muse",
        summary: "A neon-lit companion",
        tags: ["scifi", "neon"],
        appearance: { hair: "silver" },
        advancedDetails: { persona: "playful" },
        reason: "seed built-in template",
      },
    });

    expect(result.status).toBe(200);
    expect(result.data.template).toMatchObject({
      scope: "built_in",
      isActive: false,
      sortOrder: 0,
      createdById: admin,
      name: "Cyber Muse",
    });

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.template.create", targetId: result.data.template.id },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects creation without content.template.write (403)", async () => {
    // support 有 content.read 但没有 content.template.write。
    const support = `${P}support-perm`;
    await createUser({ id: support, role: "support" });
    const result = await call(createTemplate, {
      userId: support,
      role: "support",
      body: { name: "Blocked By Perm", reason: "should fail" },
    });
    expect(result.status).toBe(403);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("forbidden");
  });

  it("blocks creation when moderation flags the text (403)", async () => {
    const admin = await setupAdmin("mod");
    const result = await call(createTemplate, {
      userId: admin,
      role: "admin",
      body: { name: "underage girl", reason: "should be blocked" },
    });
    expect(result.status).toBe(403);
    expect(result.ok).toBe(false);
    // 落库前拦截：无模板被创建。
    expect(await prisma.characterTemplate.count({ where: { name: "underage girl" } })).toBe(0);
  });

  it("toggles isActive via setTemplateActive with audit", async () => {
    const admin = await setupAdmin("active");
    const created = await call(createTemplate, {
      userId: admin,
      role: "admin",
      body: { name: "Toggle Me", reason: "seed" },
    });
    const id = created.data.template.id as string;

    const online = await call((req) => setTemplateActive(req, id), {
      userId: admin,
      role: "admin",
      body: { active: true, reason: "publish template", confirmation: id },
    });
    expect(online.status).toBe(200);
    expect(online.data.template.isActive).toBe(true);

    const offline = await call((req) => setTemplateActive(req, id), {
      userId: admin,
      role: "admin",
      body: { active: false, reason: "take offline", confirmation: id },
    });
    expect(offline.data.template.isActive).toBe(false);

    expect(
      await prisma.adminAuditLog.count({ where: { action: "content.template.active", targetId: id } }),
    ).toBe(2);
  });

  it("rejects active toggles when confirmation is not the template id", async () => {
    const admin = await setupAdmin("active-confirmation");
    const created = await call(createTemplate, {
      userId: admin,
      role: "admin",
      body: { name: "Confirm Toggle Me", reason: "seed" },
    });
    const id = created.data.template.id as string;

    const rejected = await call((req) => setTemplateActive(req, id), {
      userId: admin,
      role: "admin",
      body: { active: false, reason: "take offline", confirmation: "OFFLINE" },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.code).toBe("bad_request");
    expect(
      await prisma.characterTemplate.findUniqueOrThrow({ where: { id }, select: { isActive: true } }),
    ).toEqual({ isActive: false });
  });

  it("admin listTemplates returns inactive too and is gated by content.read (403 for analyst)", async () => {
    const admin = await setupAdmin("admin-list");
    await call(createTemplate, {
      userId: admin,
      role: "admin",
      body: { name: "Admin Sees All", reason: "seed" },
    });

    const ok = await call(listTemplates, { userId: admin, role: "admin" });
    expect(ok.status).toBe(200);
    expect(ok.data.items.length).toBeGreaterThan(0);

    // analyst 没有 content.read。
    const analyst = `${P}analyst-perm`;
    await createUser({ id: analyst, role: "analyst" });
    const denied = await call(listTemplates, { userId: analyst, role: "analyst" });
    expect(denied.status).toBe(403);
  });

  it("updateTemplate not found -> 404", async () => {
    const admin = await setupAdmin("update-404");
    const result = await call((req) => updateTemplate(req, `${P}does-not-exist`), {
      userId: admin,
      role: "admin",
      method: "PATCH",
      body: { name: "Nope", reason: "missing" },
    });
    expect(result.status).toBe(404);
  });
});
