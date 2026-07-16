import { describe, expect, it } from "vitest";

import {
  activeEntitlementSummary,
  configuredEntitlementBenefits,
} from "./entitlement-copy";

describe("entitlement copy", () => {
  it("derives plan benefits from the configured feature authority", () => {
    expect(
      configuredEntitlementBenefits({
        unlimitedMessages: true,
        imageGeneration: true,
        videoGeneration: false,
        voiceEnabled: true,
        voiceMinutes: 30,
      }),
    ).toEqual([
      "Unlimited text messages",
      "30 voice minutes per billing period",
      "Image generation",
    ]);
  });

  it("derives active account copy from snake-case effective entitlements", () => {
    expect(
      activeEntitlementSummary(
        {
          unlimited_messages: true,
          voice_enabled: true,
          voice_minutes: 120,
          premium_models: true,
          premium_controls: true,
        },
        true,
      ),
    ).toBe(
      "Unlimited text messages · 120 voice minutes per billing period · Premium models · Advanced generation controls.",
    );
  });

  it("does not invent paid benefits when none are configured", () => {
    expect(activeEntitlementSummary({}, true)).toBe(
      "No additional entitlements are configured for this plan.",
    );
    expect(activeEntitlementSummary({}, false)).toBe(
      "Free: 30 text messages per day.",
    );
  });
});
