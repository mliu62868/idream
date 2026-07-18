import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const characterPreviewAssetPackSchema = z.object({
  character_cover: z.string().min(1),
  character_hero: z.string().min(1),
  character_chat: z.string().min(1),
}).strict();

const previewTokenPayloadSchema = z.object({
  version: z.literal(3),
  characterId: z.string().min(1),
  contentVersionId: z.string().min(1),
  releaseId: z.string().min(1).nullable(),
  servingVersion: z.number().int().nonnegative().nullable(),
  imageAssetId: z.string().min(1).nullable(),
  assetPack: characterPreviewAssetPackSchema,
  label: z.enum(["Live", "Draft Preview"]),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict().superRefine((value, ctx) => {
  if (
    value.label === "Live" &&
    (value.releaseId === null || value.servingVersion === null)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["servingVersion"],
      message: "Live previews must pin a Release and CharacterServing version",
    });
  }
  if (value.label === "Draft Preview" && value.servingVersion !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["servingVersion"],
      message: "Draft previews must not pin CharacterServing",
    });
  }
  if (value.imageAssetId !== value.assetPack.character_cover) {
    ctx.addIssue({
      code: "custom",
      path: ["imageAssetId"],
      message: "imageAssetId must match the exact character_cover asset",
    });
  }
  if (new Set(Object.values(value.assetPack)).size !== 3) {
    ctx.addIssue({
      code: "custom",
      path: ["assetPack"],
      message: "avatar, hero, and chat must pin three distinct assets",
    });
  }
});

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
    version: 3,
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
