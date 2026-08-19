import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { soulDraftFromWorkspace } from "./CharacterSoulPanel";

const panelSource = readFileSync(
  new URL("./CharacterSoulPanel.tsx", import.meta.url),
  "utf8",
);

describe("Character Soul editor projection", () => {
  it("round-trips gender and complete positive dialogue examples", () => {
    const positive = [{
      context: "The user changes the subject.",
      user: "Never mind.",
      assistant: "You changed direction quickly. Want me to leave it there?",
      demonstrates: ["observant", "consent-aware"],
    }];
    const data = characterWorkspaceDetail({
      soul: {
        current: {
          soul: {
            identity: {
              name: "Mira",
              age: 31,
              gender: "trans",
              relationshipArchetype: "trusted companion",
              characterPromise: "Notices what changes.",
            },
            innerLife: { personality: "Precise", values: [], wants: [], fears: [], contradictions: [], backstory: "Stable history" },
            voice: { tone: "Warm", cadence: "Measured", vocabulary: [], habits: [], avoid: [] },
            interaction: { initiative: "balanced", curiosity: "specific", pacing: "steady", affection: "earned", conflict: "direct", repair: "explicit" },
            canon: { facts: [], unknowns: [] },
            dialogue: { positive, negative: [] },
          },
        },
      },
      preview: { draft: { opening: { firstMessage: "Hello." } } },
    });
    const draft = soulDraftFromWorkspace(data);
    expect(draft?.gender).toBe("trans");
    expect(draft?.positiveDialogue).toEqual(positive);
    expect(draft?.exampleDialogue).toEqual([positive[0].assistant]);
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