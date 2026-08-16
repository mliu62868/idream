import { readdir, readFile, stat } from "node:fs/promises";
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
  /**
   * SPEC: the v1 admin dispatcher does not exist, and nothing imports it.
   * INTENT: this used to be a pair of "the dispatcher no longer contains X" string assertions,
   * one per migrated domain. Those read the dispatcher through `.catch(() => "")`, so the day
   * the file disappeared every one of them would have passed against an empty string — a guard
   * that reports success precisely when it has stopped guarding. Absence is the actual claim,
   * so assert absence.
   */
  it("has no v1 admin dispatcher left to import", async () => {
    const dispatcher = path.join(process.cwd(), "src/server/modules/admin/service.ts");
    await expect(stat(dispatcher)).rejects.toMatchObject({ code: "ENOENT" });

    const files = await sourceFiles(path.join(process.cwd(), "src/server"));
    const forbiddenImport = ["@/server/modules/admin", "service"].join("/");
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (source.includes(forbiddenImport)) offenders.push(path.relative(process.cwd(), file));
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

  it("serves generation config and dead-letter from the v2 authority tree", async () => {
    const configDomain = await readFile(
      path.join(process.cwd(), "src/server/modules/admin-v2/generation/model-profiles.ts"),
      "utf8",
    );
    const deadLetterDomain = await readFile(
      path.join(process.cwd(), "src/server/modules/admin-v2/generation/dead-letter.ts"),
      "utf8",
    );
    const catalog = await readFile(
      path.join(process.cwd(), "src/server/modules/admin-v2/generation/catalog.ts"),
      "utf8",
    );

    expect(configDomain).toContain("export async function listGenerationModelProfiles");
    expect(deadLetterDomain).toContain("export async function listGenerationDeadLetter");
    expect(catalog).toContain("export async function listGenerationRecipes");
    expect(catalog).toContain("export async function listGenerationPresets");
  });

  it("serves the content domain from Admin v2 only", async () => {
    const merchandising = await readFile(
      path.join(process.cwd(), "src/server/modules/admin-v2/content/merchandising.ts"),
      "utf8",
    );

    expect(merchandising).toContain("export async function listContentCharacters");
    expect(merchandising).toContain("export async function setCharacterVisibility");
    // The legacy idempotency primitive does not cross into v2; `executeAdminMutation` owns it.
    expect(merchandising).not.toContain("executeIdempotentDomainCommand");
  });
});
