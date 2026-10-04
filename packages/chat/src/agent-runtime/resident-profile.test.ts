import { describe, expect, it } from "vitest";
import { profileLineKey, renderResidentProfile, residentProfileFacts } from "./resident-profile";

/** Every line verified: isolates the structural cleanup from the evidence gate. */
const allSupported = (raw: string) => new Set(residentProfileFacts(raw).map(profileLineKey));

// 原始画像样本来自 2026-09-13 本机 25 个 relationship workspace 的 wake 原文。
describe("resident profile from real workspaces", () => {
  // SPEC: 关系还没有沉淀出事实时，角色应该什么都不被告知。
  //
  // INTENT: 这些占位是维护模型「没提取到」的六种说法。此前它们被原样包进
  // "What you know about this person from earlier conversations"，于是角色每一轮
  // 都读到一条关于这个人的「事实」，内容是抽取工具的行话。
  it.each([
    "# User Profile\n\n- None",
    "# User Profile\n\n- No core user-profile observations extracted.",
    "# User Profile\n\n- No core user-profile observations extracted from the target message.",
    "# User Profile\n\n- No core user-profile observations extracted from target messages.",
    "# User Profile\n\n- No core user-profile observations extracted from the provided message.",
    "# User Profile\n\n- No facts or observations to reconcile.",
  ])("says nothing at all for %j", (raw) => {
    expect(residentProfileFacts(raw)).toEqual([]);
    expect(renderResidentProfile(raw, allSupported(raw))).toBe("");
  });

  // 抽取器在解释「这不算持久属性」，然后把这句解释本身写成了一条画像。
  it("drops the extractor's reasoning about its own job", () => {
    const raw = "# User Profile\n\n- The user asked a question about the assistant's dive school, indicating momentary curiosity or task intent rather than a persistent attribute.";
    expect(residentProfileFacts(raw)).toEqual([]);
  });

  it("drops the extractor reporting an absence from its own input", () => {
    const raw = "# User Profile\n\n- The user's name is not stated in the provided message.\n- The user's occupation was not mentioned in the conversation.\n- The user has a dog named Lola.";
    expect(residentProfileFacts(raw)).toEqual(["The user has a dog named Lola."]);
  });

  it("drops a note about the extraction system itself", () => {
    const raw = "# User Profile\n\n- The user is testing the profile observation extraction system.";
    expect(residentProfileFacts(raw)).toEqual([]);
  });

  // 同一条事实被重发成带序号的第二行，角色会看到它出现两次。
  it.each([
    ["Engages in watercolor painting with a preference for teal.", "# User Profile\n\n- Engages in watercolor painting with a preference for teal.\n- 1. Engages in watercolor painting with a preference for teal."],
    ["Tends a greenhouse garden", "# User Profile\n\n- Tends a greenhouse garden\n- 1. Tends a greenhouse garden"],
    ["Likes teal and enjoys quiet photography walks with jazz", "# User Profile\n\n- Likes teal and enjoys quiet photography walks with jazz\n- 1. Likes teal and enjoys quiet photography walks with jazz"],
  ])("keeps %j exactly once", (fact, raw) => {
    expect(residentProfileFacts(raw)).toEqual([fact]);
  });

  // 一个 workspace 返回的标题是 "# Agent Memory" 而不是 "# User Profile"。
  it("ignores whichever heading the tool wrote and keeps the fact", () => {
    expect(residentProfileFacts("# Agent Memory\n\n- [2026-08-20] my favorite color is cobalt"))
      .toEqual(["[2026-08-20] my favorite color is cobalt"]);
  });

  // INVARIANT: 真实事实一条都不能少 —— 判断用户的事实是抽取器的职责，不是拼 prompt 的。
  it("keeps every real observation, including ones that look unimportant", () => {
    const raw = [
      "# User Profile",
      "",
      "- Name is Morgan.",
      "- Occupation is marine biologist.",
      "- Dog's name is Kestrel.",
      "- Allergic to shellfish.",
      "- User requested a nude photo.",
    ].join("\n");
    expect(residentProfileFacts(raw)).toEqual([
      "Name is Morgan.",
      "Occupation is marine biologist.",
      "Dog's name is Kestrel.",
      "Allergic to shellfish.",
      "User requested a nude photo.",
    ]);
  });

  it("renders surviving facts under our own heading", () => {
    const trondheim = "# User Profile\n\n- Lives in Trondheim.\n- Owns a cat named Zephyr.";
    const rendered = renderResidentProfile(trondheim, allSupported(trondheim));
    expect(rendered).toBe([
      "What you know about the person you are talking to, from earlier conversations:",
      "",
      "- Lives in Trondheim.",
      "- Owns a cat named Zephyr.",
    ].join("\n"));
  });

  it("keeps negative facts in the resident profile sent to the Character", () => {
    const raw = [
      "# User Profile",
      "",
      "- No children.",
      "- No pets.",
      "- No alcohol.",
      "- No smoking.",
      "- No information is shared without consent.",
      "- Nothing matters more than privacy.",
      "- The user likes jasmine tea.",
      "- No core user-profile observations extracted from target messages.",
    ].join("\n");
    expect(renderResidentProfile(raw, allSupported(raw))).toBe([
      "What you know about the person you are talking to, from earlier conversations:",
      "",
      "- No children.",
      "- No pets.",
      "- No alcohol.",
      "- No smoking.",
      "- No information is shared without consent.",
      "- Nothing matters more than privacy.",
      "- The user likes jasmine tea.",
    ].join("\n"));
  });

  it("says nothing for an empty or whitespace profile", () => {
    expect(renderResidentProfile("", new Set())).toBe("");
    expect(renderResidentProfile("   \n\n  ", new Set())).toBe("");
    expect(renderResidentProfile("# User Profile", new Set())).toBe("");
  });

  // SPEC: 只渲染被用户原话证实过的行；没有判定的行（旧 workspace、校验失败）不渲染。
  // INTENT: 2026-10-04 审计里「The user's name is Sophie」来自用户提问 "What's my name?"。
  it("renders only lines the user's own words were verified to support", () => {
    const raw = "# User Profile\n\n- The user's name is Kai.\n- The user's name is Sophie";
    expect(renderResidentProfile(raw, new Set([profileLineKey("The user's name is Kai")]))).toBe([
      "What you know about the person you are talking to, from earlier conversations:",
      "",
      "- The user's name is Kai.",
    ].join("\n"));
    expect(renderResidentProfile(raw, new Set())).toBe("");
  });
});
