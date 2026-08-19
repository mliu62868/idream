import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { MediaAssetAuthorityNotice } from "./MediaAssetAuthority";

// SPEC: 素材不可发布的提示按运营选的语言显示。
// INTENT: 这五句原先由模板拼接产出、整句没过 t()，中文界面上素材库就印着
//   「Not publishable: asset is archived」。当时没法靠真实服务验证 —— 库里恰好没有
//   不可发布的素材，那条路径根本没被触发，页面上英文和中文都是 0 命中。
//   所以在这里把触发条件造出来钉死：能渲染出来才算修好，不是「线上没看到英文」就算。
function render(reasons: string[]) {
  return renderToStaticMarkup(
    <AdminI18nProvider locale="zh">
      <MediaAssetAuthorityNotice
        asset={{ customerPublishable: false, publishabilityReasons: reasons } as never}
      />
    </AdminI18nProvider>,
  );
}

describe("素材可发布性提示", () => {
  it.each([
    [["platform_asset_archived"], "不可发布：素材已归档"],
    [["platform_asset_rejected"], "不可发布：素材已被驳回"],
    [["provider_untrusted"], "不可发布：生成来源不可信"],
    [[], "不可发布"],
  ])("%s → %s", (reasons, expected) => {
    const html = render(reasons as string[]);
    expect(html).toContain(expected);
    expect(html).not.toContain("Not publishable");
  });

  it("可发布时不出提示", () => {
    const html = renderToStaticMarkup(
      <AdminI18nProvider locale="zh">
        <MediaAssetAuthorityNotice
          asset={{ customerPublishable: true, publishabilityReasons: [] } as never}
        />
      </AdminI18nProvider>,
    );
    expect(html).toBe("");
  });
});
