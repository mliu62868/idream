import { describe, expect, it } from "vitest";
import { safetyDocuments } from "./ourdream-safety-data";

describe("local Safety Center content authority", () => {
  it("publishes one substantive local document for every navigation path", () => {
    expect(safetyDocuments).toHaveLength(15);
    expect(new Set(safetyDocuments.map((document) => document.path)).size).toBe(
      15,
    );
    for (const document of safetyDocuments) {
      expect(document.description.length).toBeGreaterThan(40);
      expect(document.markdown.length).toBeGreaterThan(300);
    }
  });

  it("does not expose unconfigured reference-operator facts", () => {
    const publicCopy = JSON.stringify(safetyDocuments);
    for (const unsupportedClaim of [
      "Dream Studio USA",
      "TEKTOPIA",
      "trust@ourdream.ai",
      "support@ourdream.ai",
      "discord.gg/",
      "safety.ourdream.ai",
      "Go.cam",
      "1111B South Governors",
    ]) {
      expect(publicCopy).not.toContain(unsupportedClaim);
    }
  });
});
