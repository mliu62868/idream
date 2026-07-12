import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const exposureContextPayloadSchema = z.object({
  version: z.literal(1),
  subjectType: z.enum(["user", "anonymous"]),
  subjectId: z.string().min(1),
  characterId: z.string().min(1),
  characterContentVersionId: z.string().min(1),
  characterReleaseId: z.string().min(1),
  servingVersion: z.number().int().positive(),
  placementId: z.string().min(1),
  journeyId: z.string().min(1),
  impressionExposureId: z.string().min(1),
  detailExposureId: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict();

export type ExposureContextPayload = z.infer<typeof exposureContextPayloadSchema>;

export type ExposureSubject = {
  subjectType: "user" | "anonymous";
  subjectId: string;
};

type IssueExposureContextInput = ExposureSubject & {
  characterId: string;
  characterContentVersionId: string;
  characterReleaseId: string;
  servingVersion: number;
  placementId: string;
  journeyId: string;
  now?: Date;
  ttlMs?: number;
};

export type IssuedExposureContext = {
  contextToken: string;
  journeyId: string;
  placementId: string;
  impressionExposureId: string;
  detailExposureId: string;
};

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1_000;

function signature(secret: string, encodedPayload: string) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function issueExposureContext(
  input: IssueExposureContextInput,
  secret: string,
): IssuedExposureContext {
  const issuedAt = (input.now ?? new Date()).getTime();
  const payload = exposureContextPayloadSchema.parse({
    version: 1,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    characterId: input.characterId,
    characterContentVersionId: input.characterContentVersionId,
    characterReleaseId: input.characterReleaseId,
    servingVersion: input.servingVersion,
    placementId: input.placementId,
    journeyId: input.journeyId,
    impressionExposureId: `character-impression-${randomUUID()}`,
    detailExposureId: `character-detail-${randomUUID()}`,
    issuedAt,
    expiresAt: issuedAt + (input.ttlMs ?? DEFAULT_TTL_MS),
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    contextToken: `${encodedPayload}.${signature(secret, encodedPayload)}`,
    journeyId: payload.journeyId,
    placementId: payload.placementId,
    impressionExposureId: payload.impressionExposureId,
    detailExposureId: payload.detailExposureId,
  };
}

export function verifyExposureContext(
  token: string,
  subject: ExposureSubject,
  secret: string,
  now = new Date(),
): ExposureContextPayload | null {
  const [encodedPayload, suppliedSignature, extra] = token.split(".");
  if (!encodedPayload || !suppliedSignature || extra) return null;
  const expectedSignature = signature(secret, encodedPayload);
  const expected = Buffer.from(expectedSignature);
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  try {
    const payload = exposureContextPayloadSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    );
    if (payload.subjectType !== subject.subjectType || payload.subjectId !== subject.subjectId) return null;
    if (payload.expiresAt <= now.getTime() || payload.issuedAt > now.getTime() + 60_000) return null;
    return payload;
  } catch {
    return null;
  }
}
