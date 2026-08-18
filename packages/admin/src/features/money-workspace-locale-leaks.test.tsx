import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { AccessWorkspace } from "./access/AccessWorkspace";
import { ApprovalsWorkspace } from "./approvals/ApprovalsWorkspace";
import { BillingWorkspace } from "./billing/BillingWorkspace";
import { ContentMerchandisingWorkspace } from "./content-merchandising/ContentMerchandisingWorkspace";
import { PricingWorkspace } from "./pricing/PricingWorkspace";
import { PromoWorkspace } from "./promo/PromoWorkspace";

// SPEC: 钱与增长域的工作台在中文 locale 下不得渲染出英文原文。
// INTENT: i18n-completeness.test.ts 只验证「字典里有没有这个 key」，验证不了「组件到底调没调
//         t()」。本轮的破口正是后者：label / meta 作为裸字符串 prop 传进来，接收方直接渲染，
//         字典里明明有译文（"Adjustment user ID" 早就在 i18n-zh-customers.ts 里）却用不上，
//         于是中文后台账单页整片印着 NET COINS (WINDOW) / status = active。
//         字典测试全绿，界面全英文——只有真渲染一遍才抓得到。
// INVARIANT: 这里断言的是「英文原文没出现」，不是「某句中文出现了」。译文措辞可以再改，
//            这条测试不该因为换了个说法就红。
function zh(node: React.ReactElement) {
  return renderToStaticMarkup(
    <AdminI18nProvider locale="zh">{node}</AdminI18nProvider>,
  );
}

describe("money and growth workspaces: Chinese locale leaks", () => {
  it("translates the billing labels that reach the receiver as bare string props", () => {
    const html = zh(<BillingWorkspace canAdjust canReconcile canRefund />);

    // Field label（调整表单）、AuthorityFreshness label（三个数据源名）、PageHeader purpose。
    for (const leak of [
      "Adjustment user ID",
      "Adjustment delta",
      "Ledger",
      "Subscriptions",
      "Reconciliation",
      "Reconcile subscription and Dreamcoin authority",
    ]) {
      expect(html).not.toContain(leak);
    }
  });

  it("keeps the growth workspaces' page purpose and filter labels out of English", () => {
    const surfaces = [
      zh(<PromoWorkspace canWrite />),
      zh(<PricingWorkspace canWrite />),
      zh(<ContentMerchandisingWorkspace canWrite />),
    ];

    for (const html of surfaces) {
      for (const leak of [
        "Operate redeem codes and inspect referral authority",
        "Version, publish, and roll back customer-facing generation prices",
        "Search the catalog, control visibility and lifecycle state",
        "Redeem codes",
        "Search prices",
        "Rule Key",
      ]) {
        expect(html).not.toContain(leak);
      }
    }
  });

  it("keeps the system workspaces' page purpose and filter labels out of English", () => {
    const surfaces = [
      zh(<AccessWorkspace permissions={{ changeStatus: true, managePermissions: true }} />),
      zh(<ApprovalsWorkspace canReview />),
    ];

    for (const html of surfaces) {
      for (const leak of [
        "Search users",
        "Permission user ID",
        "Permission key",
        "Search users, apply narrowly scoped permission overrides",
        "Review high-risk requests from the complete approval authority",
      ]) {
        expect(html).not.toContain(leak);
      }
    }
  });

  // SPEC: 反向守卫——英文 locale 下必须还是英文。
  // INTENT: 「把中文硬编码进 JSX」也能让上面三条全绿，但那会让英文界面反向露馅。
  it("still renders English in the English locale", () => {
    const html = renderToStaticMarkup(
      <AdminI18nProvider locale="en">
        <BillingWorkspace canAdjust canReconcile canRefund />
      </AdminI18nProvider>,
    );

    expect(html).toContain("Adjustment user ID");
    expect(html).not.toMatch(/[㐀-鿿]/);
  });
});
