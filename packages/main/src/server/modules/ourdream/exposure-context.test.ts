import { describe, expect, it } from "vitest";
import { issueExposureContext, verifyExposureContext } from "./exposure-context";

const secret = "exposure-context-test-secret-0123456789";
const now = new Date("2026-07-11T12:00:00.000Z");

function issue() {
  return issueExposureContext({
    subjectType: "user",
    subjectId: "user-1",
    characterId: "character-1",
    characterContentVersionId: "content-1",
    characterReleaseId: "release-1",
    servingVersion: 3,
    placementId: "community.leaderboard",
    journeyId: "journey-1",
    now,
    ttlMs: 60_000,
  }, secret);
}

describe("server-signed Character exposure context", () => {
  it("round-trips the exact pinned subject and Release attribution", () => {
    const issued = issue();
    expect(verifyExposureContext(issued.contextToken, {
      subjectType: "user",
      subjectId: "user-1",
    }, secret, now)).toMatchObject({
      characterId: "character-1",
      characterContentVersionId: "content-1",
      characterReleaseId: "release-1",
      servingVersion: 3,
      placementId: "community.leaderboard",
      journeyId: "journey-1",
      impressionExposureId: issued.impressionExposureId,
      detailExposureId: issued.detailExposureId,
    });
  });

  it("fails closed for tampering, subject swapping, and expiry", () => {
    const issued = issue();
    const [payload, tokenSignature] = issued.contextToken.split(".");
    expect(verifyExposureContext(`${payload}x.${tokenSignature}`, {
      subjectType: "user",
      subjectId: "user-1",
    }, secret, now)).toBeNull();
    expect(verifyExposureContext(issued.contextToken, {
      subjectType: "user",
      subjectId: "user-2",
    }, secret, now)).toBeNull();
    expect(verifyExposureContext(issued.contextToken, {
      subjectType: "user",
      subjectId: "user-1",
    }, secret, new Date(now.getTime() + 60_001))).toBeNull();
  });
});
