import { describe, expect, it } from "vitest";
import {
  characterImageQualificationBlockerSchema,
  characterImageQualificationStateSchema,
} from "@idream/shared/admin";
import { translateAdmin } from "@/components/admin/i18n";

describe("Character operator Chinese copy", () => {
  it("translates validation and authority status instead of leaking English", () => {
    for (const key of [
      "Write the first message users will receive.",
      "Identity bootstrap authority is verified in the Character workspace.",
      "Review every selected image before publishing.",
      "Review selected images",
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
});
