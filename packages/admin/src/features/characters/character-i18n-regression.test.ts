import { describe, expect, it } from "vitest";
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
});
