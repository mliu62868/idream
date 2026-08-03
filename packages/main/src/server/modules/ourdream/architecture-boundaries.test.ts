import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// SPEC: 前台（ourdream）对后台（modules/admin/**）的依赖集合必须**恰好**等于白名单。
//
// INTENT: 这里守的不是"某个符号别出现"，而是"这个方向上一共只有几条边"。
// 真实事故：GET /v1/character-templates 的公开只读投影 listActiveTemplates 曾住在
// modules/admin/characters/templates.ts 里，靠一行注释声明"公开只读，不要求 admin 权限"。
// 符号黑名单式的守卫抓不到它 —— 名字是合法的、文件是合法的、import 也编译得过。
// 只有"这个方向的边必须恰好是这一条"才会在它出现时失败。
//
// INVARIANT: 白名单只有一条 —— v1 → admin 的 dispatch 接缝（service.ts 把 /v1/admin/**
// 转交给 admin dispatcher）。任何别的 admin import 都是把后台实现拉进前台路径，
// 应该改成把那段东西搬到 ourdream/ 下，而不是加进这个白名单。
// 白名单条目消失也会失败（集合相等而非包含），所以接缝搬家时台账不会烂在这里。
//
// NOTE: admin-v2/** 不在管辖范围内 —— 那边是两侧共用的基础设施（metric writer、
// authority lock、idempotency…），不是后台实现。

// 字面量拆开拼装：这个文件本身就在被扫描的目录里，写全了会扫到自己。
const ADMIN_MODULE_PREFIX = ["@/server/modules", "admin/"].join("/");
const ALLOWED_ADMIN_IMPORTS = [[ADMIN_MODULE_PREFIX, "service"].join("")];

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(root, entry.name);
      if (entry.isSymbolicLink()) return [];
      if (entry.isDirectory()) return sourceFiles(filePath);
      return /\.(?:ts|tsx)$/.test(entry.name) ? [filePath] : [];
    }),
  );
  return nested.flat();
}

const OURDREAM_ROOT = path.join(process.cwd(), "src/server/modules/ourdream");

describe("ourdream → admin dependency direction", () => {
  it("scans a non-empty ourdream tree that contains its key files", async () => {
    const files = (await sourceFiles(OURDREAM_ROOT)).map((file) => path.basename(file));

    // 守卫自检：目录改名/移动后这里会失败，而不是静默扫描空集合然后全绿。
    expect(files.length).toBeGreaterThanOrEqual(30);
    for (const required of [
      "service.ts",
      "discovery.ts",
      "subscription-lifecycle.ts",
      "billing-checkout.ts",
      "character-templates.ts",
    ]) {
      expect(files).toContain(required);
    }
  });

  it("imports exactly the whitelisted admin modules and nothing else", async () => {
    const files = await sourceFiles(OURDREAM_ROOT);
    const found = new Map<string, string[]>();
    const specifier = new RegExp(
      `["'](${ADMIN_MODULE_PREFIX.replace(/\//g, "\\/")}[^"']+)["']`,
      "g",
    );
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(specifier)) {
        const importers = found.get(match[1]) ?? [];
        importers.push(path.relative(process.cwd(), file));
        found.set(match[1], importers);
      }
    }

    // 集合相等：多一条是新的错误依赖方向，少一条是白名单陈旧。
    expect([...found.keys()].sort()).toEqual([...ALLOWED_ADMIN_IMPORTS].sort());
  });
});
