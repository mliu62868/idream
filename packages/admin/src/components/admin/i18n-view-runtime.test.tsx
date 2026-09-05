import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminI18nProvider } from "./i18n";
import { AnnouncementsView } from "./AnnouncementsView";
import { ComplianceView } from "./ComplianceView";
import { InsightsView } from "./InsightsView";
import { AdminDevLogin } from "./AdminDevLogin";
import { StatusPill } from "./ui/StatusPill";

// SPEC: 补充静态翻译扫描：直接写在 JSX 里的中文在英文 locale 下也必须正确展示。
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
  it("keeps hardcoded Chinese out of the English locale", () => {
    const surfaces = [enMarkup(<ComplianceView />), enMarkup(<AnnouncementsView />), enMarkup(<InsightsView />)];

    for (const html of surfaces) {
      expect(html).not.toMatch(/[一-鿿]/);
    }
  });

  it("renders the Chinese locale without falling back to the English source strings", () => {
    const html = zhMarkup(<InsightsView />);

    expect(html).toContain("漏斗与留存数据暂不可用");
    expect(html).toContain("留存指标口径完成验证前，不提供相关数值或导出");
    expect(html).not.toContain("Funnel and retention data are unavailable");
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
