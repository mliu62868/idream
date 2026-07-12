import { describe, expect, it } from "vitest";
import { creativeRunCreateRequestSchema } from "./creative";

describe("Creative Run create contract", () => {
  const request = {
    purpose: "feed" as const,
    targetType: "character" as const,
    targetId: "character-1",
    profileId: "portrait-v2",
    presetIds: [],
    count: 4,
    brief: "Create an explicit feed direction with four candidates.",
    consistencyMode: "balanced" as const,
    priority: "high" as const,
    reason: "Launch the approved operator brief",
  };

  it("accepts an explicit, bounded brief", () => {
    expect(creativeRunCreateRequestSchema.parse(request)).toMatchObject(request);
  });

  it("rejects missing target identity and client-authored lifecycle state", () => {
    const { targetId: _targetId, ...missingTarget } = request;
    expect(creativeRunCreateRequestSchema.safeParse(missingTarget).success).toBe(false);
    expect(creativeRunCreateRequestSchema.safeParse({
      ...request,
      lifecycleState: "closed",
    }).success).toBe(false);
  });
});
