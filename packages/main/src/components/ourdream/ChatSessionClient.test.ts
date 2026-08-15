import { describe, expect, it } from "vitest";
import {
  chatUpgradeLinkLabel,
  voicePaymentRequiredReason,
} from "./ChatSessionClient";

describe("chat upgrade reason", () => {
  it("keeps the upgrade action aligned with the blocked capability", () => {
    expect(chatUpgradeLinkLabel("messages")).toBe(
      "Upgrade for unlimited messages",
    );
    expect(chatUpgradeLinkLabel("voice")).toBe("Upgrade for voice access");
    expect(chatUpgradeLinkLabel("dreamcoins")).toBe("Get more dreamcoins");
  });

  it("distinguishes a missing voice plan from exhausted paid usage", () => {
    expect(
      voicePaymentRequiredReason({
        error: { details: { entitlement: "voice_enabled" } },
      }),
    ).toBe("not_entitled");
    expect(
      voicePaymentRequiredReason({
        error: { details: { cost: 12, required: 12 } },
      }),
    ).toBe("insufficient_balance");
  });
});
