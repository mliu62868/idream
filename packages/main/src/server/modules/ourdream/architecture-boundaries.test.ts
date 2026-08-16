import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// SPEC: 前台（ourdream）对后台（modules/admin/**）的依赖集合必须**恰好**等于白名单。
//
// INTENT: 这里守的不是"某个符号别出现"，而是"这个方向上一共只有几条边"。
// 真实事故：GET /v1/character-templates 的公开只读投影 listActiveTemplates 曾住在
// modules/admin-v2/content/templates.ts 里，靠一行注释声明"公开只读，不要求 admin 权限"。
// 符号黑名单式的守卫抓不到它 —— 名字是合法的、文件是合法的、import 也编译得过。
// 只有"这个方向的边必须恰好是这一条"才会在它出现时失败。
//
// INVARIANT: 白名单现在是**空的**。原本唯一那条是 v1 → admin 的 dispatch 接缝
// （service.ts 把 /v1/admin/** 转交给 admin dispatcher）；admin v1 整体迁到 v2 之后
// dispatcher 已删除，这个方向上不应再有任何一条边。任何 admin import 都是把后台实现
// 拉进前台路径，应该把那段东西搬到 ourdream/ 下，而不是加进这个白名单。
// 集合相等而非包含 —— 所以这条台账在接缝消失时同样会失败，不会烂在这里。
//
// NOTE: admin-v2/** 不在管辖范围内 —— 那边是两侧共用的基础设施（metric writer、
// authority lock、idempotency…），不是后台实现。

// 字面量拆开拼装：这个文件本身就在被扫描的目录里，写全了会扫到自己。
const ADMIN_MODULE_PREFIX = ["@/server/modules", "admin/"].join("/");
const ALLOWED_ADMIN_IMPORTS: readonly string[] = [];

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

// SPEC: ourdream 内部**反向** import `./service` 的台账 —— 哪些模块、各自哪些符号 ——
// 必须恰好等于下面声明的值。
//
// INTENT: service.ts 是 v1 路由表，它 import 各领域模块是正确方向；领域模块回头 import
// service 则是「那个符号还没找到自己的家」。这条边一直存在但从没被记账，于是每轮重构都要
// 先手数一遍才知道欠多少。台账化之后：新增一条反向 import 会失败（必须显式记账并写明理由），
// 抽走一个符号后忘了更新台账也会失败（集合相等，不是包含）。
//
// INVARIANT: 每条记账都要写明**阻止它搬家的约束**（§3.1 第 5 条）。写不出约束的条目
// 就是可以马上搬走的，不该留在这里。
//
// NOTE: 测试文件 import service 不是债务（service.test.ts 就该测 dispatchV1），不记账。
const SERVICE_REVERSE_IMPORTS: Record<string, readonly string[]> = {};

const SERVICE_SPECIFIER = ["./ser", "vice"].join("");

function serviceImportedSymbols(source: string): string[] | null {
  const block = new RegExp(
    `import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${SERVICE_SPECIFIER}["']`,
    "g",
  );
  const symbols: string[] = [];
  for (const match of source.matchAll(block)) {
    for (const raw of match[1].split(",")) {
      const name = raw.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) symbols.push(name);
    }
  }
  return symbols.length > 0 ? symbols.sort() : null;
}

describe("ourdream → service 反向 import 台账", () => {
  it("每个反向 import 的符号集合恰好等于台账", async () => {
    const files = (await sourceFiles(OURDREAM_ROOT)).filter(
      (file) => !file.endsWith(".test.ts") && path.basename(file) !== "service.ts",
    );
    const found: Record<string, readonly string[]> = {};
    for (const file of files) {
      const symbols = serviceImportedSymbols(await readFile(file, "utf8"));
      if (symbols) found[path.relative(OURDREAM_ROOT, file)] = symbols;
    }

    // 逐条集合相等：多一个符号说明新债没记账，少一个说明台账陈旧没缩短。
    expect(found).toEqual(SERVICE_REVERSE_IMPORTS);
  });

  it("台账覆盖所有引用 ./service 的非测试模块（含 star / bare import）", async () => {
    // 守卫自检：上一条只认 `import { … } from "./service"`。有人写成
    // `import * as service from "./service"` 就会绕过它，这里用「文件里出现过这个
    // specifier」这个更宽的形状兜底，两个集合必须一致。
    const files = (await sourceFiles(OURDREAM_ROOT)).filter(
      (file) => !file.endsWith(".test.ts") && path.basename(file) !== "service.ts",
    );
    const referencing: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (new RegExp(`["']${SERVICE_SPECIFIER}["']`).test(source)) {
        referencing.push(path.relative(OURDREAM_ROOT, file));
      }
    }

    expect(referencing.sort()).toEqual(Object.keys(SERVICE_REVERSE_IMPORTS).sort());
  });

  // SPEC: 公开读模型的每个符号，在整个 ourdream 目录里只许有一份实现。
  //
  // INTENT: 不写符号黑名单（§3.1 第 1 条）—— 名单从 public-read-model.ts 自己的
  // export 推导，加一个导出，守卫自动开始守它。守的是「只有一份」这个形状：
  // include 与 DTO 必须同源，谁把 characterDTO 抄回 service.ts 或另起一份
  // characterInclude，这里就会失败，哪怕新副本换了文件、没被反向 import。
  it("读模型符号在 ourdream 里只有一份实现", async () => {
    const readModelPath = path.join(OURDREAM_ROOT, "public-read-model.ts");
    const readModelSource = await readFile(readModelPath, "utf8");
    const exported = [
      ...readModelSource.matchAll(
        /^export\s+(?:async\s+)?(?:function|const|type)\s+([A-Za-z_$][\w$]*)/gm,
      ),
    ].map((match) => match[1]);

    // 守卫自检：正则失配或文件被清空时，下面的循环会变成空转然后全绿。
    expect(exported.length).toBeGreaterThanOrEqual(8);
    expect(exported).toContain("characterDTO");
    expect(exported).toContain("characterInclude");

    const files = (await sourceFiles(OURDREAM_ROOT)).filter(
      (file) => !file.endsWith(".test.ts") && file !== readModelPath,
    );
    const duplicates: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const symbol of exported) {
        // 顶格锚定：import 大括号里的 `  type CharacterWithPublicRelations,` 也长得像
        // 一个 type 声明，允许前导空白会把「引用」误报成「第二份实现」。
        const definition = new RegExp(
          `^(?:export\\s+)?(?:async\\s+)?(?:function|const|type|interface)\\s+${symbol}\\b`,
          "m",
        );
        if (definition.test(source)) {
          duplicates.push(`${path.relative(OURDREAM_ROOT, file)}:${symbol}`);
        }
      }
    }

    expect(duplicates).toEqual([]);
  });
});
