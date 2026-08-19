import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminI18nProvider, hasAdminZh } from "./i18n";
import { AnnouncementsView } from "./AnnouncementsView";
import { ComplianceView } from "./ComplianceView";
import { InsightsView } from "./InsightsView";
import { reviewDecisionSuccess } from "./ReviewQueueView";
import { AdminDevLogin } from "./AdminDevLogin";
import { StatusPill } from "./ui/StatusPill";

// SPEC: i18n-completeness.test.ts 只能看见字面量 t("…")。本文件补上它看不见的两类破口：
//   1) 只经变量到达 t() 的 key（reviewDecisionSuccess 的三条结果文案）；
//   2) 直接写死在 JSX 里的中文——英文 locale 下会露馅，而中文审计器只查英文。
function zhMarkup(node: React.ReactElement) {
  return renderToStaticMarkup(
    <AdminI18nProvider locale="zh">{node}</AdminI18nProvider>,
  );
}

function enMarkup(node: React.ReactElement) {
  return renderToStaticMarkup(
    <AdminI18nProvider locale="en">{node}</AdminI18nProvider>,
  );
}

describe("legacy admin views: locale leaks", () => {
  it("translates the review decision outcomes that only reach t() through a variable", () => {
    const approvedWithPublication = reviewDecisionSuccess({
      submission: { status: "approved" },
      publication: {
        state: "publication_prep",
        projectId: "project-1",
        revisionId: "revision-1",
        servingState: "inactive",
        deepLink: "/admin/characters/character-1?tab=assets",
        created: true,
      },
    });
    const approvedWithout = reviewDecisionSuccess({
      submission: { status: "approved" },
      publication: null,
    });
    const rejected = reviewDecisionSuccess({
      submission: { status: "rejected" },
      publication: null,
    });

    for (const outcome of [approvedWithPublication, approvedWithout, rejected]) {
      expect(hasAdminZh(outcome.message)).toBe(true);
    }
  });

  it("keeps hardcoded Chinese out of the English locale", () => {
    const surfaces = [enMarkup(<ComplianceView />), enMarkup(<AnnouncementsView />), enMarkup(<InsightsView />)];

    for (const html of surfaces) {
      expect(html).not.toMatch(/[一-鿿]/);
    }
  });

  it("renders the Chinese locale without falling back to the English source strings", () => {
    const html = zhMarkup(<InsightsView />);

    expect(html).toContain("本页背后没有漏斗或分群序列");
    expect(html).not.toContain("No funnel or cohort series exists behind this page");
  });

  // SPEC: StatusPill 印出来的词一律过 value()，label 传了也一样。
  // INTENT: label 过去原样渲染，于是每个调用方都得自己记得翻——EntityCard / DetailPage 只是把
  //         statusLabel 转进来，漏掉的那个调用方就是一块英文。顺带锁住幂等：已经翻好的中文
  //         再过一次 value() 不能被改坏。
  it("translates the StatusPill label, not just the bare status", () => {
    expect(zhMarkup(<StatusPill label="approved" status="active" />)).toContain("已通过");
    expect(zhMarkup(<StatusPill label="已通过" status="active" />)).toContain("已通过");
    expect(zhMarkup(<StatusPill status="active" />)).toContain("启用");
  });

  // SPEC: dev 登录墙是运营在英文 locale 下也会撞见的第一屏，不能有硬编码中文。
  it("keeps the dev login wall out of hardcoded Chinese", () => {
    const accounts = [{ username: "admin", password: "admin123", label: "Admin · 全部权限", role: "admin" as const }];

    expect(enMarkup(<AdminDevLogin accounts={accounts} actor={null} locale="en" />)).not.toMatch(/[一-鿿]/);
    expect(zhMarkup(<AdminDevLogin accounts={accounts} actor={null} locale="zh" />)).toContain("后台登录");
  });
});
