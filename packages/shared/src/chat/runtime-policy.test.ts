import { describe, expect, it } from "vitest";
import {
  buildCharacterRuntimePolicy,
  noMemoryAuthorityReply,
} from "./runtime-policy";

describe("buildCharacterRuntimePolicy", () => {
  it("makes the no-memory promise boundary explicit", () => {
    expect(buildCharacterRuntimePolicy({ memoryEnabled: false })).toContain(
      "Never promise future recall",
    );
    expect(buildCharacterRuntimePolicy({ memoryEnabled: true })).not.toContain(
      "Never promise future recall",
    );
  });

  it("owns explicit future-memory requests outside the model", () => {
    expect(noMemoryAuthorityReply(
      "Remember this phrase next month: amber compass. Promise me.",
    )).toContain("can’t retain that across sessions");
    expect(noMemoryAuthorityReply("请记住这个词，下个月再告诉我。"))
      .toContain("无法跨会话保留");
    expect(noMemoryAuthorityReply("I remember the first day we met.")).toBeNull();
    expect(noMemoryAuthorityReply("Save this photo to my device.")).toBeNull();
  });
});
