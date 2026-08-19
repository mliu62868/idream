import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminV2RequestError } from "@/components/admin/api";
import {
  ContentMerchandisingWorkspace,
  type FeaturedItem,
  FeaturedWriteResultNotice,
  characterTableRow,
  contentCommandLabel,
  featuredDiff,
  featuredTableRow,
  featuredVersionConflictFromError,
} from "./ContentMerchandisingWorkspace";

describe("featured curation diff", () => {
  // SPEC: 保存前必须能看出这一次改了什么——输入框是一长串逗号分隔 ID，肉眼比不出来。
  it("separates additions from removals", () => {
    expect(featuredDiff(["a", "b", "c"], ["a", "c", "d"])).toEqual({
      added: ["d"],
      removed: ["b"],
      reordered: false,
    });
  });

  // INTENT: 只换顺序也是改首页曝光位次，不能显示成「没有变化」。
  it("reports a pure reorder as a change", () => {
    expect(featuredDiff(["a", "b"], ["b", "a"])).toEqual({
      added: [],
      removed: [],
      reordered: true,
    });
  });

  it("reports an identical configuration as no change at all", () => {
    expect(featuredDiff(["a", "b"], ["a", "b"])).toEqual({
      added: [],
      removed: [],
      reordered: false,
    });
  });

  it("treats clearing the whole feed as a removal of every configured id", () => {
    expect(featuredDiff(["a", "b"], [])).toEqual({
      added: [],
      removed: ["a", "b"],
      reordered: false,
    });
  });
});

describe("Content merchandising takedown targets", () => {
  // SPEC: 可见性动作能产出 unlisted，不只是 private。
  // INTENT: 筛选器有三档、服务端 content.visibility.write 收三档、清理工具用 unlisted 表达
  //         「从公开目录拿掉但保留直链」，此前动作按钮却只能打到 private —— 上线验证内容
  //         正需要 unlisted 这一档。
  it("labels each visibility target by its value", () => {
    expect(contentCommandLabel("visibility", "unlisted")).toBe("Unlist");
    expect(contentCommandLabel("visibility", "private")).toBe("Make private");
    expect(contentCommandLabel("status", "removed")).toBe("Remove");
  });

  it("offers unlist alongside make-private on every character row", () => {
    const issued: Array<[string, string, string]> = [];
    const row = characterTableRow(
      { id: "character-1", name: "Launch validation", visibility: "public" },
      true,
      (id, field, value) => issued.push([id, field, value]),
    );
    const html = renderToStaticMarkup(<div>{row.cells.at(-1)}</div>);
    expect(html).toContain("Unlist");
    expect(html).toContain("Make private");
    expect(html).toContain("Remove");
  });

  it("disables every row action without content.takedown.write", () => {
    const row = characterTableRow(
      { id: "character-1", name: "Launch validation", visibility: "public" },
      false,
      () => undefined,
    );
    const html = renderToStaticMarkup(<div>{row.cells.at(-1)}</div>);
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(3);
  });
});

describe("Content merchandising permissions", () => {
  it("renders independent authority freshness and read-only state", () => {
    const html = renderToStaticMarkup(
      <ContentMerchandisingWorkspace canWrite={false} />,
    );
    expect(html).toContain("Characters: refreshing");
    expect(html).toContain("Featured: refreshing");
    expect(html).toContain("Taking content down and changing its visibility is unavailable");
    expect(html).not.toContain("is not granted");
  });

  it("labels a configured but runtime-ineligible item as not live", () => {
    const html = renderFeaturedRow({
      id: "character-paused",
      name: "Paused Character",
      visibility: "public",
      status: "approved",
      configuredPosition: 0,
      configured: true,
      effective: false,
      blockers: [{
        code: "serving_not_live",
        message: "Character Serving is not live.",
        repairDeepLink: "/admin/characters/character-paused?tab=release",
      }],
    });

    expect(html).toContain("Configured · not live");
    expect(html).not.toContain(">Live featured<");
    expect(html).toContain("serving not live");
    expect(html).toContain("Character Serving is not live.");
    expect(html).toContain(
      'href="/admin/characters/character-paused?tab=release"',
    );
    expect(html).toContain("Resolve blocker");
  });

  it("labels only an effective item as live featured", () => {
    const html = renderFeaturedRow({
      id: "character-live",
      name: "Live Character",
      visibility: "public",
      status: "approved",
      configuredPosition: 1,
      configured: true,
      effective: true,
      blockers: [],
    });

    expect(html).toContain("Live featured");
    expect(html).not.toContain("Configured · not live");
    expect(html).toContain(">None<");
  });

  it("shows the exact saved, effective, and skipped-invalid write result", () => {
    const html = renderToStaticMarkup(
      <FeaturedWriteResultNotice
        result={{
          characterIds: ["character-paused"],
          configuredCharacterIds: ["character-paused"],
          effectiveCharacterIds: [],
          settingVersion: 4,
          settingDiagnostics: [],
          skipped: ["character-missing"],
          invalid: [{
            id: "character-missing",
            reason: "character_not_found_or_not_configurable",
          }],
        }}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Featured configuration saved");
    expect(html).toContain("1 Configured");
    expect(html).toContain("0 Live featured");
    expect(html).toContain("1 Configured · not live");
    expect(html).toContain("Skipped invalid character IDs");
    expect(html).toContain("character-missing");
    expect(html).toContain(
      "These characters were not found or cannot be configured, so they were not saved.",
    );
  });

  it("recognizes only the canonical Featured version conflict details", () => {
    expect(
      featuredVersionConflictFromError(
        new AdminV2RequestError(
          "Featured configuration changed before this save was applied",
          409,
          "conflict",
          {
            reason: "featured_setting_version_conflict",
            settingVersion: 7,
            configuredCharacterIds: ["character-current"],
          },
        ),
      ),
    ).toEqual({
      settingVersion: 7,
      configuredCharacterIds: ["character-current"],
    });
    expect(
      featuredVersionConflictFromError(
        new AdminV2RequestError("Other conflict", 409, "conflict", {}),
      ),
    ).toBeNull();
  });
});

function renderFeaturedRow(item: FeaturedItem) {
  const row = featuredTableRow(item);
  return renderToStaticMarkup(
    <table>
      <tbody>
        <tr>
          {row.cells.map((value, index) => (
            <td key={index}>{value}</td>
          ))}
        </tr>
      </tbody>
    </table>,
  );
}
