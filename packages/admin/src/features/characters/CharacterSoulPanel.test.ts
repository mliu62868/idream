import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { soulDraftFromWorkspace } from "./CharacterSoulPanel";

const panelSource = readFileSync(
  new URL("./CharacterSoulPanel.tsx", import.meta.url),
  "utf8",
);

describe("Character Soul editor projection", () => {
  it("round-trips the minimal Soul fields and keeps opening separate", () => {
    const data = characterWorkspaceDetail({
      soul: {
        current: {
          soul: {
            name: "Mira",
            age: 31,
            gender: "trans",
            relationshipArchetype: "trusted companion",
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
});
