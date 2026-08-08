import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

function source(path: string) {
  return readFileSync(path, "utf8");
}

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "test" ? [] : productionTypeScriptFiles(file);
    }
    return entry.isFile() && file.endsWith(".ts") && !file.endsWith(".test.ts")
      ? [file]
      : [];
  });
}

describe("deep module authority boundaries", () => {
  it("loads Main Prisma relations with one database join", () => {
    const schema = source("prisma/schema.prisma");

    // INVARIANT: the query relation strategy fans nested reads out inside an
    // adapter transaction. pg 9 rejects concurrent queries on that one client.
    expect(schema).toMatch(
      /previewFeatures\s*=\s*\[[^\]]*"relationJoins"[^\]]*\]/,
    );
  });

  it("keeps transaction adapters serial instead of multiplexing one pg client", () => {
    const offenders = ["src", "../chat/src"]
      .flatMap(productionTypeScriptFiles)
      .flatMap((file) => {
        const text = source(file);
        const syntax = ts.createSourceFile(
          file,
          text,
          ts.ScriptTarget.Latest,
          true,
        );
        const lines: string[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && node.expression.getText(syntax) === "Promise.all") {
            const call = node.getText(syntax);
            let owner: ts.Node | undefined = node.parent;
            while (
              owner &&
              !ts.isFunctionDeclaration(owner) &&
              !ts.isFunctionExpression(owner) &&
              !ts.isArrowFunction(owner) &&
              !ts.isMethodDeclaration(owner)
            ) {
              owner = owner.parent;
            }
            const typedTransactionNames = owner && "parameters" in owner
              ? owner.parameters.flatMap((parameter) =>
                  ts.isIdentifier(parameter.name) &&
                  parameter.type?.getText(syntax).includes("TransactionClient")
                    ? [parameter.name.text]
                    : [],
                )
              : [];
            const usesTransactionAdapter =
              /\b(?:tx|input\.tx)\./.test(call) ||
              typedTransactionNames.some((name) =>
                new RegExp(`\\b${name}\\.`).test(call),
              );
            if (!usesTransactionAdapter) {
              ts.forEachChild(node, visit);
              return;
            }
            lines.push(
              `${path.relative(process.cwd(), file)}:${
                syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1
              }`,
            );
          }
          ts.forEachChild(node, visit);
        };
        visit(syntax);
        return lines;
      });

    // INVARIANT: Prisma transaction adapters own one pg client. Promise.all
    // multiplexes queries onto it, which pg 8 deprecates and pg 9 rejects.
    expect(offenders).toEqual([]);
  });

  it("keeps image and video provider execution out of Main", () => {
    const pipeline = source("src/server/ai/local-pipeline.ts");
    const finalizer = source("src/processes/finalizer.ts");
    const providerProduction = productionTypeScriptFiles("src/server/providers")
      .map(source)
      .join("\n");

    expect(pipeline).not.toContain("providers.image.generate");
    expect(pipeline).not.toContain("providers.video.generate");
    expect(pipeline).not.toContain('job.queue === "ai.image.generate"');
    expect(pipeline).not.toContain('job.queue === "ai.video.generate"');
    expect(finalizer).not.toContain("localAiQueueNames");
    expect(providerProduction).not.toContain("IMAGE_PROVIDER");
    expect(providerProduction).not.toContain("MockImageModel");
    expect(providerProduction).not.toContain("PipelineImageModel");
    expect(providerProduction).not.toContain("MockVideoModel");
    expect(providerProduction).not.toMatch(/\b(image|video):\s*(create|new )/);
  });

  it("keeps DreamcoinLedger production writes inside the billing ledger owner", () => {
    const writers = productionTypeScriptFiles("src/server")
      .filter((file) => /dreamcoinLedger\.(create|upsert|update|delete)/.test(source(file)))
      .map((file) => path.relative(process.cwd(), file));

    expect(writers).toEqual(["src/server/modules/billing/ledger.ts"]);
  });

  it("forbids cross-service Redis delivery and the optional HTTP cutover flag", () => {
    const roots = ["../shared/src", "src", "../chat/src"];
    const production = roots.flatMap(productionTypeScriptFiles).map(source).join("\n");

    expect(production).not.toContain("MAIN_TO_CHAT_QUEUE");
    expect(production).not.toContain("MAIN_QUEUES.mainInbound");
    expect(production).not.toContain('"chat.inbound"');
    expect(production).not.toContain('"main.inbound"');
    expect(production).not.toContain("CHAT_DURABLE_INGEST_URL");
  });

  // SPEC: 「下一步做什么 / 完成度多少 / 卡在哪」由服务端 journey 投影下发，前端只许消费。
  // INTENT: 上一版守卫只读 CharacterWorkspace.tsx 一个文件、只拉黑两个已经修过一次的符号名，
  // 真正的漂移住在 CharacterAssetStudio.tsx 且用的是新名字，守卫完全看不见。符号黑名单只能抓住
  // 你已经修过的漂移，所以这里改成断言「形状」：整个 characters 前端目录里不许出现「自己推导
  // 图池完成度 / 用途顺序」和「用前端自造的链接顶掉服务端 deepLink」这两类写法。
  it("keeps Character production-journey derivation on the server", () => {
    const characterUiDirectory = "../admin/src/features/characters";
    const files = readdirSync(characterUiDirectory, { withFileTypes: true })
      .filter((entry) =>
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name)
      )
      .map((entry) => path.join(characterUiDirectory, entry.name));

    // 守卫自检：目录被改名/搬走时必须炸，而不是静默扫描一个空集合然后全绿。
    expect(files.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining([
        "CharacterAssetStudio.tsx",
        "CharacterWorkspace.tsx",
      ]),
    );
    expect(files.length).toBeGreaterThanOrEqual(5);

    for (const file of files) {
      const ui = source(file);
      // 自己数图池槽位（Object.values(assetPack).filter(...)）—— 服务端已给
      // journey.assetPack.{draft,live}.{completed,total,missingPurposes}。
      expect(ui, file).not.toMatch(/Object\.(values|keys|entries)\(\s*[\w.?]*[Aa]ssetPack\b/);
      // 自己推用途顺序（找第一个「pack 里没有」的 purpose）—— 服务端已给 missingPurposes，
      // 而且它还额外过滤了资产可用性（软删 / 归属），前端那版只看 routeCurrent。
      expect(ui, file).not.toMatch(/=>\s*!\s*[\w.?]*[Pp]ack[\w.?]*\[/);
      // 用前端自造的片段链接顶掉服务端下发的 deepLink。
      expect(ui, file).not.toMatch(/deepLink:\s*[^,\n]*`#\$\{/);
    }

    // 正向：前端确实在读服务端算好的答案。
    const consumed = files.map(source).join("\n");
    expect(consumed).toContain("journey.assetPack.draft.missingPurposes");
    expect(consumed).toContain("journey.assetPack.live");
    expect(consumed).toContain("journey.primaryAction");

    const portfolio = source("src/server/modules/admin-v2/characters/portfolio.ts");
    const workspace = source("src/server/modules/admin-v2/characters/workspace.ts");
    expect(portfolio).toContain("projectCharacterProductionJourneys");
    expect(portfolio).toContain("journey,");
    expect(workspace).toContain("journey: portfolioItem.journey");
  });

  // SPEC: blocker deepLink 里的页内锚点必须指向 admin 里真实存在的控件。
  // INTENT: 服务端拼出的锚点字符串本身测不出问题——真正的失败模式是它与 admin 的 DOM id 漂移，
  // 而漂移之后链接依然「合法」，只是点了不跳转。这条守卫跨包对账，两边任一侧改名都会炸。
  it("keeps every server blocker anchor pointing at a control that exists in admin", () => {
    const links = source(
      "src/server/modules/admin-v2/characters/character-deep-link.ts",
    );
    const anchorBlock = links.match(
      /CHARACTER_WORKSPACE_ANCHORS[^=]*=\s*\{([\s\S]*?)\n\} as const/,
    )?.[1];
    expect(anchorBlock, "CHARACTER_WORKSPACE_ANCHORS block not found")
      .toBeTruthy();

    // 捕获整段引号内容而不是「合法字符」子集——否则一个含意外字符的漂移值会被截成合法前缀，
    // 守卫反而放行（写这条时就踩了一次）。
    const anchors = [
      ...new Set(
        [...anchorBlock!.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]),
      ),
    ];
    expect(anchors.length).toBeGreaterThanOrEqual(3);

    const adminUi = readdirSync("../admin/src/features/characters")
      .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
      .map((name) => source(path.join("../admin/src/features/characters", name)))
      .join("\n");

    for (const anchor of anchors) {
      expect(adminUi, `no id="${anchor}" in admin characters UI`).toContain(
        `id="${anchor}"`,
      );
    }
  });

  // SPEC: 服务端下发的 ?tab= 必须是 admin 真的会渲染的那一个。
  // INTENT: 锚点对账只能证明「片段存在」，证明不了「落在哪个页面/哪个 tab」。此前
  // readiness.ts 发过 ?tab=visual-identity / ?tab=persona / ?tab=overview 三个 admin 根本没有的
  // tab，全部静默回落到缺省 tab；路线类 blocker 更是指向 /admin/ops/profiles 再挂一个角色工作台
  // 才有的锚点。tab 词表是跨包契约，这里断言两侧**集合相等**——admin 新增/改名/删除都会炸。
  it("keeps the server workspace tab vocabulary equal to the admin one", () => {
    const tabList = (text: string, symbol: string) => {
      const block = text.match(
        new RegExp(`${symbol}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`),
      )?.[1];
      expect(block, `${symbol} block not found`).toBeTruthy();
      return [...block!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    };

    const server = tabList(
      source("src/server/modules/admin-v2/characters/character-deep-link.ts"),
      "CHARACTER_WORKSPACE_TABS",
    );
    const admin = tabList(
      source("../admin/src/features/image-workflow-transport.ts"),
      "characterWorkspaceTabs",
    );

    expect(server.length).toBeGreaterThanOrEqual(6);
    expect(server).toEqual(admin);
  });

  // SPEC: 角色运营台链接只有 character-deep-link 一个构造入口。
  // INTENT: 上一条断言的是那张表里的值对不对，管不住「有人绕过表再手拼一条」。运营台链接坏掉是
  // 静默的——URL 合法、页面能打开、只是打开了错的地方，没有任何测试会红。所以这里断言**写法**
  // 在整个 characters 目录里不得出现，而不是拉黑某几个已经修过的字符串。
  it("keeps character workspace deep links to a single builder", () => {
    const directory = "src/server/modules/admin-v2/characters";
    const files = productionTypeScriptFiles(directory);

    // 守卫自检：目录改名/搬走时必须炸，而不是静默扫描空集合。
    expect(files.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining([
        "character-deep-link.ts",
        "production-journey.ts",
        "workspace.ts",
        "readiness.ts",
      ]),
    );
    expect(files.length).toBeGreaterThanOrEqual(30);

    const builders = files.filter((file) =>
      // 模板字符串直接以 /admin/characters/ 开头即为手拼（`/api/v2/admin/characters/…` 不匹配）。
      /`\/admin\/characters\//.test(source(file))
    ).map((file) => path.basename(file));

    expect(builders).toEqual(["character-deep-link.ts"]);
  });
});
