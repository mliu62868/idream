import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CreativeRunDetail } from "@idream/shared/admin";
import { CandidateBatchGrid } from "./CharacterAssetStudioStage";

describe("Character Asset Studio candidate failure", () => {
  it("shows an actionable reason while keeping machine detail folded and does not promise a retry", () => {
    const items = [{
      id: "failed-item",
      ordinal: 0,
      status: "failed",
      version: 1,
      executionState: "failed",
      asset: null,
      review: null,
      lineage: null,
      failure: {
        errorCode: "backend_error",
        operatorGuidance: "本轮没有产生可审核图片。请载入本轮参数，调整后重新生成。",
      },
    }] as unknown as CreativeRunDetail["items"];

    const html = renderToStaticMarkup(
      <CandidateBatchGrid
        activeItemId="failed-item"
        activePurpose="character_cover"
        comparisonItemId={null}
        disabled={false}
        items={items}
        onActivate={() => undefined}
        onCompare={() => undefined}
        runId="failed-run"
        selectedPackAssetId={null}
        subjectName="Mira"
      />,
    );

    expect(html).toContain("The generation backend threw an error");
    expect(html).toContain("Open run details");
    expect(html).toContain("Technical detail");
    expect(html).not.toContain("Open run to retry");
    expect(html).not.toContain("本轮没有产生可审核图片");
  });
});
