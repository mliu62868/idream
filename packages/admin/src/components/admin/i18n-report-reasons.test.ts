import { CONTENT_REPORT_REASONS } from "@idream/shared";
import { describe, expect, it } from "vitest";
import { translateAdmin } from "@/components/admin/i18n-dictionary";

// SPEC: 用户能选的每一个举报理由，在审核队列的「分类」列上都必须是中文。
// INTENT: 举报理由是共享枚举，加一个取值只需改 packages/shared 一处 —— 没有这条守卫，
//         admin 会静默地把新取值原样渲染成英文（`underage` 当年就是这样漏出去的）。
describe("举报理由的中文覆盖", () => {
  it("每个理由都有中文，不回落成原值", () => {
    for (const reason of CONTENT_REPORT_REASONS) {
      const zh = translateAdmin("zh", reason);
      expect(zh, `${reason} 缺中文`).not.toBe(reason);
      expect(zh).not.toMatch(/[a-z]_[a-z]/);
    }
  });

  it("英文 locale 原样返回", () => {
    expect(translateAdmin("en", "underage_content")).toBe("underage_content");
  });

  // SPEC: 枚举收口只管**写入**，读取路径（adminContracts moderation 的 category 仍是
  //       z.string().min(1)）照旧放行历史取值 —— 审核队列必须显示得出来，且是中文。
  // INTENT: 实测库里有枚举之前入库的裸 `underage`。它不在 CONTENT_REPORT_REASONS 里，
  //         上面那条守卫覆盖不到，而 value() 查不到就原样返回 —— 中文界面上漏出英文。
  it("历史裸取值也有中文", () => {
    for (const legacy of ["underage", "spam", "other_prohibited_content"]) {
      expect(translateAdmin("zh", legacy), `${legacy} 缺中文`).not.toBe(legacy);
    }
  });
});
