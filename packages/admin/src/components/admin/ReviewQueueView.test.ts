import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewDecisionSuccess } from "./ReviewQueueView";

const source = readFileSync(new URL("./ReviewQueueView.tsx", import.meta.url), "utf8");

describe("review decision success", () => {
  it("links approved customer submissions to publication preparation without claiming they are live", () => {
    expect(reviewDecisionSuccess({
      submission: { status: "approved" },
      publication: {
        state: "publication_prep",
        projectId: "project-1",
        revisionId: "revision-1",
        servingState: "inactive",
        deepLink: "/admin/characters/character-1?tab=assets",
        created: true,
      },
    })).toEqual({
      message: "Approved. Awaiting publication: complete assets, QA, and Release before the character goes live.",
      href: "/admin/characters/character-1?tab=assets",
    });
  });

  // SPEC: 决策按钮在窄屏横滚时必须还在视野里，表格本身要能用键盘滚动。
  // INVARIANT: 这两件事由 ui/DataTable 提供（stickyLastColumn + role="region" tabIndex 的滚动容器，
  //   见 DataTable.test.tsx），本页只负责把开关打开——所以这里钉的是「用了原语并开了开关」，
  //   不再逐字节钉一份本地手搓的 sticky 样式。
  it("keeps review decisions reachable through the shared table primitive", () => {
    expect(source).toContain("stickyLastColumn");
    expect(source).toContain('minimumWidthClassName="min-w-[860px]"');
    expect(source).not.toContain("sticky right-0");
  });

  // SPEC: 表头是运营读的中文文案，不是后端字段名。
  it("never labels a column with a raw authority field name", () => {
    expect(source).not.toContain('"submittedAt"');
    expect(source).toContain('t("Submitted")');
  });
});
