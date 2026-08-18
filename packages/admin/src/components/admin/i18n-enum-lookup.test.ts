import { describe, expect, it } from "vitest";
import { translateAdmin } from "@/components/admin/i18n-dictionary";

// SPEC: 22 个调用点写的是 t(value.replaceAll("_", " ")) —— 它们要的是「人读的形态」。
//       枚举译文按下划线形态存在 zhValues 里。查表必须让两种形态都命中。
// INTENT: 修之前，字典里明明有 in_progress / resolved / closed 等 7 条中文，却因为
//         查表是精确匹配、空格形态永远落空，中文界面的 Cases 页上直接渲染出
//         content report / in progress / recently resolved / support request 四个英文徽章。
//         这类 bug 不会被任何既有守卫抓到：字面量确实包了 t()，字典里确实有词条，
//         只有真正跑起来看渲染结果才发现。所以在这里钉死。
describe("多词枚举的中英查表", () => {
  const CASES = [
    ["in_progress", "进行中"],
    ["waiting_on_user", "等待用户"],
    ["content_report", "内容举报"],
    ["support_request", "支持请求"],
    ["recently_resolved", "近期已解决"],
    ["billing_dispute", "账务争议"],
    ["no_violation", "未违规"],
  ] as const;

  it("下划线形态查得到", () => {
    for (const [raw, zh] of CASES) expect(translateAdmin("zh", raw)).toBe(zh);
  });

  // 这条才是真正的回归守卫：调用点传进来的就是空格形态。
  it("空格形态同样查得到", () => {
    for (const [raw, zh] of CASES) {
      expect(translateAdmin("zh", raw.replaceAll("_", " "))).toBe(zh);
    }
  });

  it("英文 locale 原样返回，不受回落影响", () => {
    expect(translateAdmin("en", "in progress")).toBe("in progress");
  });

  // INVARIANT: 回落只在精确匹配全部落空后才试，绝不覆盖已有的精确译文。
  it("不覆盖精确匹配", () => {
    expect(translateAdmin("zh", "All")).not.toBe("");
    expect(translateAdmin("zh", "All")).toBe(translateAdmin("zh", "All"));
  });
});
