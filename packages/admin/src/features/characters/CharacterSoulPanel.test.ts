import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import {
  CharacterSoulPanel,
  compileSoulDraftPreview,
  soulDraftFromWorkspace,
} from "./CharacterSoulPanel";

const panelSource = readFileSync(
  new URL("./CharacterSoulPanel.tsx", import.meta.url),
  "utf8",
);

describe("Character Soul editor projection", () => {
  it("keeps the operator form visible and technical artifacts collapsed", () => {
    const html = renderToStaticMarkup(createElement(CharacterSoulPanel, { data: characterWorkspaceDetail({ soul: { current: { soul: { name: "Mira", age: 31, gender: "female", characterPromise: "Notices what changes.", detailsMarkdown: "" } } }, preview: { draft: { opening: { firstMessage: "Hello." } } } }), canWrite: true, runCommittedMutation: async ({ commit }) => ({ result: await commit(), refreshed: true }) }));
    expect(html).toContain("Soul editor");
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

  // SPEC: 新建 Soul 版本会顶替角色人格权威，必须过统一确认框。
  // INTENT: 原先只有一个 reason 输入框加一个按钮——同一个工作台里"改标签"要走对话框，
  // 这里却不用，门槛正好倒置。ConfirmDialog 自己收 reason ≥3，所以行内输入框一并删掉。
  it("routes a new Soul version through the shared confirmation", () => {
    expect(panelSource).toContain("ConfirmDialog");
    expect(panelSource).toContain("onClick={() => setConfirmOpen(true)}");
    expect(panelSource).toContain(
      "This becomes the authoritative persona for new chat.",
    );
    // 提交只能来自对话框，不能还留一条绕过它的直接调用。
    expect(panelSource).not.toContain("void createVersion()");
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
