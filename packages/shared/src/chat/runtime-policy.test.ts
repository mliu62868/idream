import { describe, expect, it } from "vitest";
import {
  buildCompanionRuntimeAuthority,
  noMemoryAuthorityReply,
} from "./runtime-policy";

describe("buildCompanionRuntimeAuthority", () => {
  it("says nothing at all on an ordinary memory-on turn", () => {
    const policy = buildCompanionRuntimeAuthority({ memoryEnabled: true });
    expect(policy).toBe("");
    expect(policy).toBe(buildCompanionRuntimeAuthority({ memoryEnabled: true, imageToolEnabled: false }));
  });

  it("makes the no-memory promise boundary explicit", () => {
    expect(buildCompanionRuntimeAuthority({ memoryEnabled: false })).toContain(
      "never say it is saved or will be remembered",
    );
    expect(buildCompanionRuntimeAuthority({ memoryEnabled: true })).not.toContain(
      "Memory is off",
    );
  });

  it("requires the image bridge for explicit generate and edit requests", () => {
    const enabled = buildCompanionRuntimeAuthority({
      memoryEnabled: true,
      imageToolEnabled: true,
    });
    expect(enabled).toContain("call generate_image_async");
    expect(enabled).toContain("call edit_last_image");
    expect(enabled).toContain("A photo exists only once the tool call succeeds");

    const disabled = buildCompanionRuntimeAuthority({
      memoryEnabled: true,
      imageToolEnabled: false,
    });
    expect(disabled).not.toContain("generate_image_async");
    expect(disabled).not.toContain("edit_last_image");
  });

  it("never mentions photos on a non-photo turn", () => {
    const disabled = buildCompanionRuntimeAuthority({ memoryEnabled: false, imageToolEnabled: false });
    expect(disabled).not.toMatch(/photo|image|selfie/iu);
    expect(disabled).not.toContain("you may offer");
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
