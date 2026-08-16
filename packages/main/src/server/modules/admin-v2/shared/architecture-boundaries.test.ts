import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(filePath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [filePath] : [];
  }));
  return nested.flat();
}

describe("Admin v2 architecture boundaries", () => {
  it("does not depend on the legacy admin service monolith", async () => {
    const roots = [
      path.join(process.cwd(), "src/server/modules/admin-v2"),
      path.join(process.cwd(), "src/app/api/v2/admin"),
    ];
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const offenders: string[] = [];
    const forbiddenImport = ["@/server/modules/admin", "service"].join("/");
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (source.includes(forbiddenImport)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps legacy domain modules independent from the dispatcher monolith", async () => {
    const root = path.join(process.cwd(), "src/server/modules/admin");
    const dispatcher = path.join(root, "service.ts");
    const files = (await sourceFiles(root)).filter((file) => file !== dispatcher);
    const offenders: string[] = [];
    const forbiddenImport = ["@/server/modules/admin", "service"].join("/");
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (source.includes(forbiddenImport)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * SPEC: 「一个 Creative Run 存在」这一事实只能由一处代码写出来。
   * INTENT: 断言的是**形状**（谁在 insert 那张表），不是符号黑名单 —— 换个函数名、搬到
   * 另一个文件都照样会被抓到。创建逻辑此前埋在 legacy `admin/content-ops.ts` 里而 v2
   * 路由直接 import 它；再长出第二个入口（"复制 Run"、批量重跑之类）就会出现两套
   * 路线 pin / 幂等 / 审计语义。测试与 e2e 里的 fixture 播种不算写权威，故只扫 src/server
   * 的非测试源码。
   */
  it("keeps Creative Run creation to a single write implementation", async () => {
    const root = path.join(process.cwd(), "src/server");
    const files = (await sourceFiles(root)).filter((file) => !/\.test\.tsx?$/.test(file));
    const label = (file: string) => path.relative(root, file).split(path.sep).join("/");
    // Self-check: 目录改名后静默扫成空集合再全绿，比没有守卫更糟。
    expect(files.length).toBeGreaterThan(200);
    expect(files.map(label)).toContain("modules/admin-v2/creative/run-create.ts");

    const writers: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/\bcontentProductionBatch\s*\.\s*create\s*\(/.test(source)) writers.push(label(file));
    }
    expect(writers).toEqual(["modules/admin-v2/creative/run-create.ts"]);
  });

  it("keeps the legacy user domain implementation out of the dispatcher monolith", async () => {
    const dispatcher = await readFile(
      path.join(process.cwd(), "src/server/modules/admin/service.ts"),
      "utf8",
    );
    const userDomain = await readFile(
      path.join(process.cwd(), "src/server/modules/admin/users/service.ts"),
      "utf8",
    ).catch(() => "");

    expect(dispatcher).not.toContain("const statusChangeSchema");
    expect(dispatcher).not.toContain("async function listUsers");
    expect(dispatcher).not.toContain("async function setUserPermission");
    expect(userDomain).toContain("export async function listUsers");
    expect(userDomain).toContain("export async function setUserPermission");
    expect(userDomain).not.toContain(["@/server/modules/admin", "service"].join("/"));
  });

  it("keeps generation config and dead-letter authorities out of the dispatcher monolith", async () => {
    const dispatcher = await readFile(
      path.join(process.cwd(), "src/server/modules/admin/service.ts"),
      "utf8",
    );
    const configDomain = await readFile(
      path.join(process.cwd(), "src/server/modules/admin/generation/config/service.ts"),
      "utf8",
    ).catch(() => "");
    const deadLetterDomain = await readFile(
      path.join(process.cwd(), "src/server/modules/admin/generation/dead-letter/service.ts"),
      "utf8",
    ).catch(() => "");

    expect(dispatcher).not.toContain("const modelProfileSchema");
    expect(dispatcher).not.toContain("async function listModelProfiles");
    expect(dispatcher).not.toContain("async function deadLetterQueue");
    expect(dispatcher).not.toContain("async function requeueDeadLetterBatch");
    expect(configDomain).toContain("export async function listModelProfiles");
    expect(deadLetterDomain).toContain("export async function deadLetterQueue");
    expect(configDomain).not.toContain(["@/server/modules/admin", "service"].join("/"));
    expect(deadLetterDomain).not.toContain(["@/server/modules/admin", "service"].join("/"));
  });

  it("keeps moderation and access authorities out of the dispatcher monolith", async () => {
    const dispatcher = await readFile(path.join(process.cwd(), "src/server/modules/admin/service.ts"), "utf8");
    const moderation = await readFile(path.join(process.cwd(), "src/server/modules/admin/moderation/service.ts"), "utf8").catch(() => "");
    const access = await readFile(path.join(process.cwd(), "src/server/modules/admin/users/service.ts"), "utf8");

    expect(dispatcher).not.toContain("const adminDecisionSchema");
    expect(dispatcher).not.toContain("async function moderationQueue");
    expect(dispatcher).not.toContain("async function moderationDecision");
    expect(moderation).toContain("export async function moderationQueue");
    expect(moderation).not.toContain(["@/server/modules/admin", "service"].join("/"));
    expect(dispatcher).not.toContain("async function listUsers");
    expect(access).toContain("export async function listUsers");
  });

  it("keeps support and approvals authorities out of the dispatcher monolith", async () => {
    const root = path.join(process.cwd(), "src/server/modules/admin");
    const dispatcher = await readFile(path.join(root, "service.ts"), "utf8");
    const support = await readFile(path.join(root, "support/service.ts"), "utf8").catch(() => "");
    const approvals = await readFile(path.join(root, "approvals/service.ts"), "utf8").catch(() => "");

    expect(dispatcher).not.toContain("const supportRequestPatchSchema");
    expect(dispatcher).not.toContain("async function listSupportRequests");
    expect(dispatcher).not.toContain("async function viewPlaintext");
    expect(dispatcher).not.toContain("const approvalCreateSchema");
    expect(dispatcher).not.toContain("async function listApprovals");
    expect(support).toContain("export async function listSupportRequests");
    expect(approvals).toContain("export async function listApprovals");
  });

  it("keeps Chat Ops proxy authority out of the dispatcher monolith", async () => {
    const root = path.join(process.cwd(), "src/server/modules/admin");
    const dispatcher = await readFile(path.join(root, "service.ts"), "utf8");
    const chat = await readFile(path.join(root, "chat/service.ts"), "utf8").catch(() => "");

    expect(dispatcher).not.toContain("type ChatAdminProxyResult");
    expect(dispatcher).not.toContain("async function proxyChatAdmin");
    expect(dispatcher).not.toContain("async function chatOpsOverview");
    expect(chat).toContain("export async function chatOpsOverview");
    expect(chat).not.toContain(["@/server/modules/admin", "service"].join("/"));
  });

  it("keeps content merchandising authority out of the dispatcher monolith", async () => {
    const root = path.join(process.cwd(), "src/server/modules/admin");
    const dispatcher = await readFile(path.join(root, "service.ts"), "utf8");
    const content = await readFile(path.join(root, "content/merchandising.ts"), "utf8").catch(() => "");
    expect(dispatcher).not.toContain("const contentVisibilitySchema");
    expect(dispatcher).not.toContain("async function listContentCharacters");
    expect(dispatcher).not.toContain("async function putFeaturedCharacters");
    expect(content).toContain("export async function listContentCharacters");
    expect(content).toContain("executeIdempotentDomainCommand");
  });

  it("keeps overview and generic saved-view authorities out of the dispatcher", async () => {
    const root = path.join(process.cwd(), "src/server/modules/admin");
    const dispatcher = await readFile(path.join(root, "service.ts"), "utf8");
    const overviews = await readFile(path.join(root, "overviews/service.ts"), "utf8").catch(() => "");
    const savedViews = await readFile(path.join(root, "saved-views/service.ts"), "utf8").catch(() => "");
    expect(dispatcher).not.toContain("async function analyticsOverview");
    expect(dispatcher).not.toContain("async function abuseOverview");
    expect(dispatcher).not.toContain("async function providerOps");
    expect(dispatcher).not.toContain("async function listSavedViews");
    expect(dispatcher).not.toContain("const savedViewCreateSchema");
    expect(overviews).toContain("export async function analyticsOverview");
    expect(savedViews).toContain("export async function createSavedView");
    expect(savedViews).toContain("executeIdempotentDomainCommand");
  });

  it("leaves the legacy dispatcher as a route table and compatibility export surface", async () => {
    const root = path.join(process.cwd(), "src/server/modules/admin");
    const dispatcher = await readFile(path.join(root, "service.ts"), "utf8");
    const dashboard = await readFile(path.join(root, "dashboard/service.ts"), "utf8");
    const generation = await readFile(path.join(root, "generation/catalog-admin.ts"), "utf8");
    expect(dispatcher.match(/(?:export )?async function /g)).toEqual([
      "export async function ",
    ]);
    expect(dispatcher).not.toContain("prisma.");
    expect(dispatcher).not.toContain("z.object(");
    expect(dashboard).toContain("export async function adminDashboard");
    expect(generation).toContain("export async function listRecipes");
    expect(generation).toContain("export async function listAdminPresets");
  });
});
