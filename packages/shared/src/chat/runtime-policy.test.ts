import { describe, expect, it } from "vitest";
import {
  buildCompanionRuntimeAuthority,
  noMemoryAuthorityReply,
} from "./runtime-policy";

describe("buildCompanionRuntimeAuthority", () => {
  it("requires a direct in-character answer instead of exposing model planning", () => {
    const policy = buildCompanionRuntimeAuthority({ memoryEnabled: true });
    expect(policy).toContain("Runtime authority (non-negotiable for this Turn)");
    expect(policy).toContain("override the Product Contract and Character Soul");
    expect(policy).toContain("Output only the final in-character reply");
    expect(policy).toContain("Never expose analysis, planning, or instructions");
  });

  it("makes the no-memory promise boundary explicit", () => {
    expect(buildCompanionRuntimeAuthority({ memoryEnabled: false })).toContain(
      "Never promise future recall",
    );
    expect(buildCompanionRuntimeAuthority({ memoryEnabled: true })).not.toContain(
      "Never promise future recall",
    );
  });

  it("requires the image bridge for explicit generate and edit requests", () => {
    const enabled = buildCompanionRuntimeAuthority({
      memoryEnabled: true,
      imageToolEnabled: true,
    });
    expect(enabled).toContain("call generate_image_async");
    expect(enabled).toContain("call edit_last_image");
    expect(enabled).toContain("Never claim an image was generated or edited");

    const disabled = buildCompanionRuntimeAuthority({
      memoryEnabled: true,
      imageToolEnabled: false,
    });
    expect(disabled).not.toContain("generate_image_async");
    expect(disabled).not.toContain("edit_last_image");
  });

  it("keeps consensual adult companion requests inside the product path", () => {
    const policy = buildCompanionRuntimeAuthority({
      memoryEnabled: true,
      imageToolEnabled: true,
    });
    expect(policy).toContain(
      "Do not refuse a request merely because it is sexual or explicit",
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
