import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { CaseWorkspace } from "./cases/CaseWorkspace";
import { ModerationWorkspace } from "./moderation/ModerationWorkspace";
import { SupportWorkspace } from "./support/SupportWorkspace";

// SPEC: 人域四个工作台（客服 / 审核 / 工单 / 客户）在 zh 下不得漏英文。
// INTENT: 这些泄漏不是「忘了写词条」，而是**接收方组件没过 t()**：`Freshness` 裸渲染 label、
//         `Select` 拿 `t(空格形态)` 去查一张只有下划线键的表、`PageHeader` 根本不翻 purpose。
//         词条补得再全也救不回来，所以这里钉的是「渲染出来的是中文」，不是「字典里有这个键」。
// INVARIANT: 断言用中文译文本身。译文改了这里就该跟着改——这正是要的：改译文必须是自觉行为。
function zh(node: React.ReactNode) {
  return renderToStaticMarkup(<AdminI18nProvider locale="zh">{node}</AdminI18nProvider>);
}

describe("people workspaces render Chinese under the zh locale", () => {
  // 回归：`PageHeader` 不翻译 purpose（它住在 ui/，本轮不动），所以调用点必须自己 t()。
  // 此前两个工作台的首屏导语整段是英文。
  it("translates the support workspace purpose and filter enums", () => {
    const html = zh(<SupportWorkspace canViewPlaintext={false} canWrite={false} />);

    expect(html).toContain("分诊完整客服请求权威数据");
    expect(html).not.toContain("Triage the complete support request authority");
    // <option> 走 value()（zhValues 下划线键）。"waiting_on_user" 是多词枚举，
    // 正是旧的 t(空格形态) 查不中、于是吐英文的那一类。
    expect(html).toContain("等待用户");
    expect(html).not.toContain(">waiting_on_user<");
  });

  // 回归：`Freshness` 以前裸渲染 label，于是三条新鲜度提示的开头永远是英文队列名，
  // 后半截却是中文——同一行里中英文各一半。
  it("translates the moderation queue names in the freshness line", () => {
    const html = zh(<ModerationWorkspace canDecide={false} />);

    expect(html).toContain("举报");
    expect(html).toContain("媒体审核");
    expect(html).toContain("申诉");
    expect(html).not.toContain("Media review");
    expect(html).not.toContain(">Appeals<");
    expect(html).toContain("每个决定都会确认、审计并传播");
  });

  // 回归：工单的类型 / 队列视图 / 排序都是枚举。`Select` 与 `CaseTabs` 以前把它们
  // 变成空格形态再查主表，而主表里从来没有 "content report" 这种键。
  it("translates case types, queue views, and sort options", () => {
    const html = zh(<CaseWorkspace canAssign={false} canDecide={false} />);

    expect(html).toContain("内容举报");
    expect(html).toContain("账务争议");
    expect(html).toContain("未分配");
    expect(html).toContain("最近已解决");
    expect(html).toContain("最近更新在前");
    expect(html).not.toContain("content report");
    expect(html).not.toContain("recently resolved");
    expect(html).not.toContain("updated_desc<");
  });
});
