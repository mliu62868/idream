import { describe, expect, it } from "vitest";
import { mockVideoMp4Bytes } from "./mock-video";

describe("mock video fixture", () => {
  it("returns reusable MP4 bytes", () => {
    const bytes = Buffer.from(mockVideoMp4Bytes());

    expect(bytes.length).toBeGreaterThan(1_000);
    expect(bytes.subarray(4, 12).toString("ascii")).toBe("ftypisom");
  });
});
