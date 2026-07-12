import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const previewTokenPayloadSchema = z.object({
  version: z.literal(1),
  characterId: z.string().min(1),
  contentVersionId: z.string().min(1),
  releaseId: z.string().min(1).nullable(),
  label: z.enum(["Live", "Draft Preview"]),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict();

export type CharacterPreviewTokenPayload = z.infer<typeof previewTokenPayloadSchema>;

const PREVIEW_TTL_MS = 30 * 60 * 1_000;

function sign(encoded: string, secret: string) {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

export function issueCharacterPreviewToken(
  input: Omit<CharacterPreviewTokenPayload, "version" | "issuedAt" | "expiresAt">,
  secret: string,
  now = new Date(),
) {
  const issuedAt = now.getTime();
  const payload = previewTokenPayloadSchema.parse({
    version: 1,
    ...input,
    issuedAt,
    expiresAt: issuedAt + PREVIEW_TTL_MS,
  });
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyCharacterPreviewToken(
  token: string,
  secret: string,
  now = new Date(),
): CharacterPreviewTokenPayload | null {
  const [encoded, suppliedSignature, extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra) return null;
  const expected = Buffer.from(sign(encoded, secret));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = previewTokenPayloadSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    if (payload.expiresAt <= now.getTime() || payload.issuedAt > now.getTime() + 60_000) return null;
    return payload;
  } catch {
    return null;
  }
}
