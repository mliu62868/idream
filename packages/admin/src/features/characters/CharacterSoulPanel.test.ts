import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import {
  CharacterSoulPanel,
  compileSoulDraftPreview,
  soulDraftFromWorkspace,
} from "./CharacterSoulPanel";

describe("Character Soul editor projection", () => {
  it("keeps the operator form visible and technical artifacts collapsed", () => {
    const html = renderToStaticMarkup(createElement(CharacterSoulPanel, { actorId: "test-admin", data: characterWorkspaceDetail({ soul: { current: { soul: { name: "Mira", age: 31, gender: "female", characterPromise: "Notices what changes.", detailsMarkdown: "" } } }, preview: { draft: { opening: { firstMessage: "Hello." } } } }), canWrite: true, runCommittedMutation: async ({ commit }) => ({ result: await commit(), refreshed: true }) }));
    expect(html).toContain("Persona");
    expect(html).toContain("Appearance");
    expect(html).toContain("Technical details");
    expect(html).toContain("Generated SOUL.md");
    expect(html).toContain("Compiled system prompt");
    expect(html.match(/<details[^>]*>/g)).toHaveLength(3);
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|>)/);
  });

  it("round-trips the minimal Soul fields and keeps opening separate", () => {
    const data = characterWorkspaceDetail({
      soul: {
        current: {
          soul: {
            name: "Mira",
            age: 31,
            gender: "trans",
            characterPromise: "Notices what changes.",
            detailsMarkdown: "## Voice\nWarm and precise.",
          },
        },
      },
      preview: { draft: { opening: { firstMessage: "Hello." } } },
    });
    const draft = soulDraftFromWorkspace(data);
    expect(draft?.gender).toBe("trans");
    expect(draft?.detailsMarkdown).toBe("## Voice\nWarm and precise.");
    expect(draft?.firstMessage).toBe("Hello.");
  });

  it("compiles the unsaved form values for both live preview artifacts", () => {
    const preview = compileSoulDraftPreview({
      name: "Mira",
      age: 31,
      gender: "trans",
      characterPromise: "LIVE DRAFT PREVIEW SHOULD APPEAR",
      detailsMarkdown: "## Voice\nWarm and precise.",
      firstMessage: "Hello.",
    });

    expect(preview).toMatchObject({
      markdown: expect.stringContaining("LIVE DRAFT PREVIEW SHOULD APPEAR"),
      systemPrompt: expect.stringContaining("LIVE DRAFT PREVIEW SHOULD APPEAR"),
    });
    expect(preview?.markdown).toBe(preview?.systemPrompt);
  });
});
