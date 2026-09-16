import { describe, expect, it } from "vitest";
import { mentionedGroupCharacter } from "./GroupSpeakerControls";

// SPEC: 开头的 @名字 决定这一轮谁回答。认不出来必须返回 null —— 猜错人比不切换更糟。
const members = [
  { characterId: "bailey", sessionId: "member-1", name: "Bailey Price: One Safe Night" },
  { characterId: "nova", sessionId: "member-2", name: "Nova Quill E2E" },
];

describe("group speaker mention", () => {
  it("matches the full Character name", () => {
    expect(mentionedGroupCharacter("@Nova Quill E2E your turn", members)).toBe("nova");
  });

  it("matches what a person actually types: an unambiguous first name", () => {
    expect(mentionedGroupCharacter("@Bailey and what do you say?", members)).toBe("bailey");
    expect(mentionedGroupCharacter("@bailey, your turn", members)).toBe("bailey");
    expect(mentionedGroupCharacter("@Nova: one line please", members)).toBe("nova");
  });

  it("refuses to guess between two members sharing a prefix", () => {
    const ambiguous = [
      ...members,
      { characterId: "bailey-2", sessionId: "member-3", name: "Bailey Winters" },
    ];
    expect(mentionedGroupCharacter("@Bailey hey", ambiguous)).toBeNull();
  });

  it("prefers a full name over another member it is a prefix of", () => {
    const overlapping = [
      { characterId: "mira", sessionId: "member-1", name: "Mira" },
      { characterId: "mira-vale", sessionId: "member-2", name: "Mira Vale" },
    ];
    expect(mentionedGroupCharacter("@Mira hey", overlapping)).toBe("mira");
    expect(mentionedGroupCharacter("@Mira Vale hey", overlapping)).toBe("mira-vale");
  });

  it.each([
    ["no mention at all", "Hello you two"],
    ["a mention that is not at the start", "Hey @Nova what do you think"],
    ["a bare at sign", "@ who is there"],
    ["an unknown name", "@Sasha hello"],
  ])("returns null for %s", (_case, content) => {
    expect(mentionedGroupCharacter(content, members)).toBeNull();
  });
});
