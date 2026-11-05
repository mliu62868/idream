import { describe, expect, it } from "vitest";
import {
  discoveryExposureIssuer,
  exposureJourneyId,
  issueExposureContext,
  verifyExposureContext,
} from "./exposure-context";

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

  const subject = { subjectType: "user", subjectId: "user-1" } as const;
  const live = {
    id: "character-1",
    serving: {
      state: "live",
      version: 3,
      currentRelease: { id: "release-1", status: "published", characterContentVersionId: "content-1" },
    },
  };

  it("keeps one exposure per journey, Character, placement and Release", () => {
    const issue = discoveryExposureIssuer(subject, secret, now);
    const first = issue(live, "explore.feed");
    const refetched = discoveryExposureIssuer(subject, secret, new Date(now.getTime() + 1_000))(live, "explore.feed");
    expect(refetched?.journeyId).toBe(first?.journeyId);
    expect(refetched?.impressionExposureId).toBe(first?.impressionExposureId);
    expect(refetched?.detailExposureId).toBe(first?.detailExposureId);
    expect(first?.detailExposureId).not.toBe(first?.impressionExposureId);

    const otherIds = [
      issue(live, "explore.search"),
      issue({ ...live, id: "character-2" }, "explore.feed"),
      issue({ ...live, serving: { ...live.serving, currentRelease: { ...live.serving.currentRelease, id: "release-2" } } }, "explore.feed"),
    ].map((context) => context?.impressionExposureId);
    expect(new Set([first?.impressionExposureId, ...otherIds]).size).toBe(4);
  });

  it("starts a new journey per subject and per 30 minute window", () => {
    const journey = exposureJourneyId(subject, secret, now);
    expect(exposureJourneyId({ ...subject, subjectId: "user-2" }, secret, now)).not.toBe(journey);
    expect(exposureJourneyId({ subjectType: "anonymous", subjectId: "user-1" }, secret, now)).not.toBe(journey);
    expect(exposureJourneyId(subject, secret, new Date(now.getTime() + 30 * 60 * 1_000))).not.toBe(journey);
  });

  it("signs only a live Serving on a published Release for a known subject", () => {
    const issue = discoveryExposureIssuer(subject, secret, now);
    expect(issue(live, "explore.feed")).not.toBeNull();
    expect(discoveryExposureIssuer(null, secret, now)(live, "explore.feed")).toBeNull();
    expect(issue({ ...live, serving: null }, "explore.feed")).toBeNull();
    expect(issue({ ...live, serving: { ...live.serving, state: "paused" } }, "explore.feed")).toBeNull();
    expect(issue({ ...live, serving: { ...live.serving, currentRelease: null } }, "explore.feed")).toBeNull();
    expect(issue({
      ...live,
      serving: { ...live.serving, currentRelease: { ...live.serving.currentRelease, status: "retired" } },
    }, "explore.feed")).toBeNull();
  });
});
