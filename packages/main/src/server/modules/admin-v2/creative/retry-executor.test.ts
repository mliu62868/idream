import { describe, expect, it } from "vitest";
import { generationProfileHealth } from "./retry-executor";

describe("generationProfileHealth", () => {
  it.each([
    [null, false, "generation_profile_missing"],
    [{ enabled: false, status: "active", runnerConfig: null }, false, "generation_profile_inactive"],
    [{ enabled: true, status: "draft", runnerConfig: null }, false, "generation_profile_inactive"],
    [
      { enabled: true, status: "active", runnerConfig: { verificationStatus: "failed_probe" } },
      false,
      "generation_profile_failed_probe",
    ],
    [{ enabled: true, status: "active", runnerConfig: { verificationStatus: "passed" } }, true, null],
  ] as const)("fails closed for unhealthy provider/profile evidence", (profile, healthy, reason) => {
    expect(generationProfileHealth(profile)).toEqual({ healthy, reason });
  });
});
