import { describe, expect, it } from "vitest";
import { characterCommandFailure, characterCommandFailureMessage } from "./release-command";

describe("characterCommandFailureMessage", () => {
  it("names the withdrawal when release checks failed", () => {
    const failure = characterCommandFailure("failed", {
      code: "release_validation_failed",
      blockers: ["opening_complete"],
      candidateWithdrawn: true,
    });
    expect(characterCommandFailureMessage(failure)).toBe(
      "Release checks failed. The candidate was withdrawn and the draft can be edited again.",
    );
  });

  // SPEC: a candidate withdrawn without check blockers (e.g. a snapshot that cannot project) must
  //       still be explained; "Command failed." alone hides that the draft is editable again.
  it("names the withdrawal even when no release-check blockers were recorded", () => {
    const failure = characterCommandFailure("failed", {
      code: "release_projection_invalid",
      candidateWithdrawn: true,
    });
    expect(characterCommandFailureMessage(failure)).toBe(
      "The release could not go live. The candidate was withdrawn and the draft can be edited again.",
    );
  });

  it("keeps the generic copy for ordinary failures", () => {
    expect(characterCommandFailureMessage(characterCommandFailure("failed", { code: "serving_missing" }))).toBe("Command failed.");
    expect(characterCommandFailureMessage(characterCommandFailure("cancelled", null))).toBe("Command cancelled.");
  });
});
