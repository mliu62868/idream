import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// SPEC: 前台直接读 `/api/v1/me` 的文件台账必须**恰好**等于下面这份清单。
//
// INTENT: 守的不是"别用这个字符串"，而是"这条边一共有几处，各自为什么"。
// 真实事故：2026-09-02 一天之内落了九笔同形修复（把读绑定到已确认账号、按 owner
// 分区 state、丢弃迟到响应），因为同一条不变式在每个工作台各写了一遍。九天后的
// e82b0122e 又新增了四个面，每个面照样重写一遍——修九次也拦不住第十次。
// 集合相等把"再写一遍"变成一次必须解释的记账动作。
//
// INVARIANT: 清单只减不增。一个条目消失（迁到 useViewerGate）必须同时从这里删掉，
// 否则这条台账会烂成一张永远对不上的旧地图——所以用集合相等，不是包含。
//
// NOTE: 守的是文件集合，不是出现次数。一个文件读两次和读一次同样要记账；
// 真正要问的是"这个面凭什么自己回答'谁在看'"。
const DIRECT_VIEWER_READERS: Record<string, string> = {
  // 这一份是权威本身：所有人的答案都来自它。
  "viewer-auth.ts": "解析 /api/v1/me 的唯一实现",

  // 以下五个是 viewer-auth.ts 文件头 INVARIANT 声明的豁免，各自需要一个
  // 共享缓存给不出的答案：
  "AuthWorkspace.tsx": "登录失败后实时复查，必须看见本标签页刚发生的写入",
  "AgeGateBoundary.tsx": "每次路由变化重读 ageGate.accepted，要看见刚刚的接受",
  "AuthNav.tsx": "用更严的 parseAuthMeResponse 取显示名与邮箱，且有自己的不可用态",
  "CreateWorkspace.tsx": "按 viewer 给 localStorage 草稿分域，陈旧 id 会在共用浏览器上串号",
  "CollectionDetail.tsx": "合集所有权判定，尚未迁移",

  // 以下是尚未迁移到 useViewerGate 的存量面。迁一个删一行。
  "GeneratorWorkspace.tsx": "自有 epoch/scope 三元组，未迁移",
  "ChatSessionClient.tsx": "自有 sessionMutationEpoch，未迁移",
  "HelpDeskWorkspace.tsx": "自有 viewerScope，未迁移",
  "HelpDeskConversation.tsx": "自有 owner 判定，未迁移",
  "CoinStoreWorkspace.tsx": "自有 scope + generation + signedInAs 重读，未迁移",
  "ChatVideoAttachmentCard.tsx": "自有 owner 判定，未迁移",
  "RecoveryCodeCard.tsx": "自有 serial，未迁移",
};

const ROOT = path.join(process.cwd(), "src/components/ourdream");
const DIRECT_READ = /fetch\(\s*["'`]\/api\/v1\/me/;

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(root, entry.name);
      if (entry.isSymbolicLink()) return [];
      if (entry.isDirectory()) return sourceFiles(filePath);
      if (!/\.(?:ts|tsx)$/.test(entry.name)) return [];
      return /\.(?:test|spec)\.tsx?$/.test(entry.name) ? [] : [filePath];
    }),
  );
  return nested.flat();
}

describe("viewer authority direct reads", () => {
  it("scans a non-empty ourdream tree that still contains its gated surfaces", async () => {
    const names = (await sourceFiles(ROOT)).map((file) => path.basename(file));

    // 守卫自检：目录改名或移动后这里失败，而不是静默扫描空集合然后全绿。
    expect(names.length).toBeGreaterThanOrEqual(40);
    for (const required of ["viewer-auth.ts", "ComicStudio.tsx", "GeneratorWorkspace.tsx"]) {
      expect(names).toContain(required);
    }
  });

  it("reads the viewer directly from exactly the accounted-for files", async () => {
    const files = await sourceFiles(ROOT);
    const found: string[] = [];
    for (const file of files) {
      if (DIRECT_READ.test(await readFile(file, "utf8"))) found.push(path.basename(file));
    }

    // 多一条 = 又一个面在自己回答"谁在看"；少一条 = 台账没跟上迁移。
    expect(found.sort()).toEqual(Object.keys(DIRECT_VIEWER_READERS).sort());
  });

  it("gives every accounted-for file a reason", () => {
    for (const [file, reason] of Object.entries(DIRECT_VIEWER_READERS)) {
      expect(reason, `${file} 缺少记账理由`).not.toHaveLength(0);
    }
  });
});
