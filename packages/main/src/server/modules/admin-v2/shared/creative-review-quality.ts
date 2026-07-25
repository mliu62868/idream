import { z } from "zod";
import {
  CHARACTER_IDENTITY_APPROVAL_MIN_SCORE,
  creativeReviewEvidenceSchema,
  creativeReviewQualityEvidenceSchema,
} from "@idream/shared/admin";

const legacySupersedingReviewEvidenceSchema =
  creativeReviewQualityEvidenceSchema.extend({
    supersedesDecisionId: z.string().trim().min(1),
  }).strict();

export function creativeReviewQuality(value: unknown) {
  const canonical = creativeReviewEvidenceSchema.safeParse(value);
  if (canonical.success) return canonical.data.quality;

  const parsed = creativeReviewQualityEvidenceSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  const legacySuperseding = legacySupersedingReviewEvidenceSchema.safeParse(value);
  if (legacySuperseding.success) {
    return {
      artifactFree: legacySuperseding.data.artifactFree,
      singleSubject: legacySuperseding.data.singleSubject,
      intentMatch: legacySuperseding.data.intentMatch,
      noVisibleText: legacySuperseding.data.noVisibleText,
    };
  }

  return null;
}

export function creativeReviewQualityPassed(value: unknown) {
  const quality = creativeReviewQuality(value);
  return quality !== null && Object.values(quality).every(Boolean);
}

export function characterIdentityReviewEvidencePassed(input: {
  readonly bootstrapIdentity: boolean;
  readonly decision: string;
  readonly identityConsistency: string;
  readonly score: number | null;
  readonly evidence: unknown;
}) {
  return input.decision === "approved" &&
    input.identityConsistency ===
      (input.bootstrapIdentity ? "unscored" : "passed") &&
    (
      input.bootstrapIdentity ||
      (
        input.score !== null &&
        input.score >= CHARACTER_IDENTITY_APPROVAL_MIN_SCORE
      )
    ) &&
    creativeReviewQualityPassed(input.evidence);
}
