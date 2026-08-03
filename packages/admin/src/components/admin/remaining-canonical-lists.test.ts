import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FEATURES_DIR = fileURLToPath(new URL("../../features/", import.meta.url));

/** features/ 下每个功能目录里的全部非测试源码，按目录遍历而不是写死清单。 */
function allFeatureSources(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const feature of readdirSync(FEATURES_DIR)) {
    const dir = join(FEATURES_DIR, feature);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (name.includes(".test.")) continue;
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      files.push({ path: `${feature}/${name}`, text: readFileSync(join(dir, name), "utf8") });
    }
  }
  return files;
}

const source = [
  readFileSync(new URL("./AdminConsoleClient.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("./AnnouncementsView.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/audit/AuditWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/audit/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/pricing/PricingWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/pricing/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/billing/BillingWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/billing/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/config/GenerationConfigWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/config/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/dead-letter/DeadLetterWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/dead-letter/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/access/AccessWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/access/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/moderation/ModerationWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/moderation/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/support/SupportWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/support/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/promo/PromoWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/promo/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/approvals/ApprovalsWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/approvals/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/chat-ops/ChatOpsWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/chat-ops/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/content-merchandising/ContentMerchandisingWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/content-merchandising/query.ts", import.meta.url), "utf8"),
].join("\n");

describe("remaining canonical admin list surfaces", () => {
  it("persists every compatibility list cursor in URL state and restores browser history", () => {
    for (const cursor of [
      "ledgerCursor",
      "subscriptionCursor",
      "pricingCursor",
      "deadCursor",
      "accessCursor",
      "reportCursor",
      "mediaCursor",
      "appealCursor",
      "auditCursor",
      "contentCursor",
      "promoCursor",
      "referralCursor",
      "approvalCursor",
      "profileCursor",
      "flagCursor",
      "chatSessionCursor",
      "chatUsageCursor",
      "chatEventCursor",
      "announcementCursor",
    ]) {
      expect(source, cursor).toContain(cursor);
    }
    expect(source).toContain('window.history.pushState(null, ""');
    expect(source).toContain('window.addEventListener("popstate"');
  });

  // INTENT: 上面那些 `toContain` 断言把 26 个文件拼成一个大字符串再问「含不含 X」——
  //   这种形状**加文件只会更容易通过**，所以它的扫描域窄反而无害（也无用：一个游标
  //   出现在 26 个文件里的任何一个都算数，定位不到是哪个）。
  //   下面这两条是**否定式**的，特性正相反：扫得越全越强。而实测 features/ 下有 18 个
  //   目录带 query.ts，上面的清单只列了 12 个 —— cases / compatibility-lists / customers /
  //   incidents / jobs / overviews 六个从来没被扫过，其中 compatibility-lists 正是这条
  //   守卫名字里的那个概念。所以否定式断言改用目录遍历，新增 feature 自动纳入。
  it("sends search and filters to server endpoints instead of filtering loaded rows", () => {
    const everyFeatureSource = allFeatureSources();
    // 守卫自检：遍历必须真的覆盖到全部 18 个 feature，否则空转的扫描会无声通过。
    expect(everyFeatureSource.length).toBeGreaterThanOrEqual(18);
    const offenders = everyFeatureSource.filter(
      (file) => /rows\.filter\(/.test(file.text) || /JSON\.stringify\(row\)/.test(file.text),
    );
    expect(
      offenders.map((file) => file.path),
      "列表筛选必须发给服务端，不能在已加载的行上做",
    ).toEqual([]);
    for (const endpoint of [
      "/billing/ledger",
      "/billing/subscriptions",
      "/pricing/rules",
      "/generation/dead-letter",
      "/moderation/queue",
      "/audit-log",
      "/content/characters",
      "/promo/redeem-codes",
      "/promo/referrals",
      "/approvals",
      "/generation/model-profiles",
      "/feature-flags",
      "/chat/sessions",
      "/chat/usage",
      "/chat/moderation-events",
      "/announcements",
    ]) {
      expect(source, endpoint).toContain(endpoint);
    }
  });

  it("distinguishes filtered emptiness from a genuinely empty authority", () => {
    expect(source).toContain("No ledger entries match these filters");
    expect(source).toContain("No audit events exist yet");
    expect(source).toContain("No dead-letter jobs match these filters");
    expect(source).toContain("No chat sessions exist yet");
    expect(source).toContain("No approval requests are pending");
  });
});
