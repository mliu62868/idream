import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

    expect(writers).toEqual(["src/server/modules/admin/billing/ledger.ts"]);
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
    const workspace = source("src/server/modules/admin-v2/characters/workspace.ts");
    const anchorBlock = workspace.match(
      /VISUAL_BLOCKER_ANCHORS[^=]*=\s*\{([\s\S]*?)\};/,
    )?.[1];
    expect(anchorBlock, "VISUAL_BLOCKER_ANCHORS block not found").toBeTruthy();

    // 捕获整段引号内容而不是「合法字符」子集——否则一个含意外字符的漂移值会被截成合法前缀，
    // 守卫反而放行（写这条时就踩了一次）。
    const anchors = [
      ...new Set([...anchorBlock!.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1])),
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
});
