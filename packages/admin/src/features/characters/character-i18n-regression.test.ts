import { describe, expect, it } from "vitest";
import {
  characterImageQualificationBlockerSchema,
  characterImageQualificationStateSchema,
} from "@idream/shared/admin";
import { translateAdmin } from "@/components/admin/i18n";
import { CHARACTER_IMMEDIATE_EFFECT_COPY } from "./character-immediate-effects";

describe("Character operator Chinese copy", () => {
  it("translates validation and authority status instead of leaking English", () => {
    for (const key of [
      "Write the first message users will receive.",
      "Identity bootstrap authority is verified in the Character workspace.",
      "Review every selected image before publishing.",
      "Repair persona",
    ]) {
      expect(translateAdmin("zh", key), key).not.toBe(key);
    }
  });

  it("translates imported image Review and placement actions without reusing voice copy", () => {
    for (const key of [
      "Image imported as a Review candidate",
      "Review approved. This image is now selectable.",
      "Review rejected. This image remains in the library but cannot be selected.",
      "Image Review failed",
      "Review imported Character image",
      "Qualify imported image",
      "This decision is pinned to the current sealed Visual Identity. Initial identity sources belong in Identity Lab; this path qualifies final Cover, Hero, and Chat candidates.",
      "Close Review",
      "Identity matches the current sealed Character",
      "Visible Review reason",
      "Approve for placement",
      "Reject candidate",
      "Needs attention: {reasons}",
      "Review again",
      "No reviewed images are selectable for this placement. Review an imported candidate or approve a matching generated image in Images first.",
      "Update Review authority",
    ]) {
      expect(translateAdmin("zh", key), key).not.toBe(key);
    }
    expect(translateAdmin("zh", "Review image candidate")).toBe("审核候选图片");
    expect(translateAdmin("zh", "Review candidate")).toBe("审核候选声音");
  });

  it("translates every server-owned image qualification state and blocker shown in the library", () => {
    for (const value of [
      ...characterImageQualificationStateSchema.options,
      ...characterImageQualificationBlockerSchema.options,
    ]) {
      const key = value.replaceAll("_", " ");
      expect(translateAdmin("zh", key), value).not.toBe(key);
    }
  });

  // SPEC: 绕过 Release 的改动在动作处和发布页用同一句话；这些 key 有的经 t(常量) 取值，静态扫描看不到。
  it("translates the immediate-effect copy and the failure retry explanation", () => {
    expect(translateAdmin("zh", CHARACTER_IMMEDIATE_EFFECT_COPY)).toBe("立即对新会话生效，不随发布。");
    for (const key of [
      "Retry happens on the Run page, which keeps the retry command's idempotency record so a refresh or second click cannot start another paid generation. To change the source or brief, create a new video here instead.",
      "Open run to retry",
      "Open run details",
      "Voice defaults",
      "Inherited by every character",
    ]) {
      expect(translateAdmin("zh", key), key).not.toBe(key);
    }
  });
});
