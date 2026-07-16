type EntitlementValues = Record<string, unknown>;

function enabled(
  values: EntitlementValues,
  camelCaseKey: string,
  snakeCaseKey: string,
) {
  return values[camelCaseKey] === true || values[snakeCaseKey] === true;
}

function numericValue(
  values: EntitlementValues,
  camelCaseKey: string,
  snakeCaseKey: string,
) {
  const value = values[camelCaseKey] ?? values[snakeCaseKey];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function configuredEntitlementBenefits(
  values: EntitlementValues,
): string[] {
  const benefits: string[] = [];

  if (enabled(values, "unlimitedMessages", "unlimited_messages")) {
    benefits.push("Unlimited text messages");
  }

  if (enabled(values, "voiceEnabled", "voice_enabled")) {
    const voiceMinutes = numericValue(values, "voiceMinutes", "voice_minutes");
    benefits.push(
      voiceMinutes
        ? `${voiceMinutes.toLocaleString()} voice minutes per billing period`
        : "Voice generation",
    );
  }

  if (enabled(values, "imageGeneration", "image_generation")) {
    benefits.push("Image generation");
  }

  if (enabled(values, "videoGeneration", "video_generation")) {
    benefits.push("Video generation");
  }

  if (enabled(values, "premiumModels", "premium_models")) {
    benefits.push("Premium models");
  }

  if (enabled(values, "premiumControls", "premium_controls")) {
    benefits.push("Advanced generation controls");
  }

  return benefits;
}

export function activeEntitlementSummary(
  entitlements: EntitlementValues,
  hasActiveSubscription: boolean,
) {
  if (!hasActiveSubscription) {
    return "Free: 30 text messages per day.";
  }

  const benefits = configuredEntitlementBenefits(entitlements);
  return benefits.length > 0
    ? `${benefits.join(" · ")}.`
    : "No additional entitlements are configured for this plan.";
}
