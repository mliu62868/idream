import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { ImagePackResetNotice, draftSelectedImageCount } from "./ImagePackResetNotice";
import { VisualIdentityPanel } from "./VisualIdentityPanel";

describe("draft image pack reset warning", () => {
  it("reads the chosen-image count from the server journey and stays silent at zero", () => {
    const data = characterWorkspaceDetail({
      journey: { assetPack: { draft: {
        availablePurposes: ["character_cover", "character_chat"], missingPurposes: ["character_hero"], completed: 2, total: 3,
      } } },
    });
    expect(draftSelectedImageCount(data)).toBe(2);
    expect(renderToStaticMarkup(<ImagePackResetNotice count={0} />)).toBe("");
    expect(renderToStaticMarkup(<ImagePackResetNotice count={2} />)).toContain("This clears the 2 cover, hero, and chat images");
  });

  it("warns beside the identity and reference writes that clear the pack", () => {
    const data = characterWorkspaceDetail({
      journey: { assetPack: { draft: {
        availablePurposes: ["character_cover"], missingPurposes: ["character_hero", "character_chat"], completed: 1, total: 3,
      } } },
    });
    const html = renderToStaticMarkup(
      <VisualIdentityPanel
        actorId="admin"
        data={data}
        navigateToTab={() => undefined}
        permissions={{ writeVisual: true, evaluateRoute: false }}
        runCommittedMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
      />,
    );
    expect(html).toContain("This clears the 1 cover, hero, and chat images");
  });
});
