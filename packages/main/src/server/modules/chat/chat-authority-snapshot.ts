import type { ChatAuthoritySnapshot } from "@idream/shared/bff";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";

/** Main is the sole reader and compiler of facts admitted into one Agent run. */
export async function loadChatAuthoritySnapshot(
  userId: string,
  pin: {
    characterId: string;
    contentVersionId: string;
    releaseId: string | null;
    visualProfileId: string | null;
    visualProfileVersion: number | null;
  },
): Promise<ChatAuthoritySnapshot> {
  const now = new Date();
  const [user, ageGate, ageVerification, entitlementRows, character, contentVersion, release] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, include: { preferences: true } }),
    prisma.ageGateAcceptance.findFirst({ where: { userId }, orderBy: { acceptedAt: "desc" } }),
    prisma.ageVerification.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.entitlement.findMany({
      where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: { createdAt: "asc" },
    }),
    prisma.character.findUnique({
      where: { id: pin.characterId },
      include: {
        visualProfiles: pin.visualProfileId && pin.visualProfileVersion
          ? { where: { id: pin.visualProfileId, version: pin.visualProfileVersion }, take: 1 }
          : { where: { id: "__no_visual_profile__" }, take: 1 },
      },
    }),
    prisma.characterContentVersion.findUnique({ where: { id: pin.contentVersionId } }),
    pin.releaseId ? prisma.characterRelease.findUnique({ where: { id: pin.releaseId } }) : null,
  ]);
  if (!user) throw Errors.unauthorized("Authenticated user no longer exists");
  if (!character || contentVersion?.characterId !== pin.characterId) {
    throw Errors.gone("Pinned Character content is unavailable");
  }
  if (pin.releaseId && (!release || release.characterContentVersionId !== pin.contentVersionId)) {
    throw Errors.gone("Pinned Character Release is unavailable");
  }
  if (release && (
    release.visualProfileId !== pin.visualProfileId ||
    release.visualProfileVersion !== pin.visualProfileVersion
  )) {
    throw Errors.gone("Pinned Character visual identity does not belong to the Release");
  }
  const entitlements = new Map(entitlementRows.map((row) => [row.key, row.value]));
  const visual = character.visualProfiles[0] ?? null;
  if (pin.visualProfileId && !visual) {
    throw Errors.gone("Pinned Character visual identity is unavailable");
  }
  const advanced = record(character.advancedDetails);
  return {
    version: 1,
    user: {
      id: user.id,
      displayName: user.displayName,
      locale: user.preferences?.locale ?? "en",
      status: user.status,
      deletedAt: user.deletedAt?.toISOString() ?? null,
      dataClass: user.dataClass,
    },
    eligibility: {
      ageGateAccepted: Boolean(ageGate),
      ageVerified: ageVerification?.status === "verified",
      jurisdiction: ageVerification?.jurisdiction ?? null,
      restrictedReason: user.deletedAt
        ? "account_deleted"
        : user.status === "suspended" ? "account_suspended" : null,
    },
    entitlement: {
      modelTier: planTier(entitlements),
      unlimitedMessages: jsonBoolean(entitlements.get("unlimited_messages")),
      voiceEnabled: jsonBoolean(entitlements.get("voice_enabled")),
      imageToolEnabled: jsonBoolean(entitlements.get("image_tool_enabled"), true),
    },
    character: {
      characterId: character.id,
      creatorId: character.creatorId,
      name: character.name,
      age: character.age,
      description: character.description,
      systemPrompt: character.systemPrompt,
      visibility: character.visibility,
      status: character.status,
      voiceId: character.voiceId,
      visualProfileId: visual?.id ?? null,
      visualProfileVersion: visual?.version ?? null,
      identityPrompt: visual?.identityPrompt ?? null,
      imageToolEnabled: jsonBoolean(advanced?.imageToolEnabled, true),
      deletedAt: character.deletedAt?.toISOString() ?? null,
      contentVersion: {
        contentVersionId: contentVersion.id,
        characterId: contentVersion.characterId,
        version: contentVersion.version,
        contentHash: contentVersion.contentHash,
        personaSnapshot: contentVersion.personaSnapshot,
        openingSnapshot: contentVersion.openingSnapshot,
        appearanceSnapshot: contentVersion.appearanceSnapshot,
      },
      release: release ? {
        releaseId: release.id,
        characterId: character.id,
        characterContentVersionId: release.characterContentVersionId,
        status: release.status,
        version: release.version,
        snapshotHash: release.snapshotHash,
        visualProfileId: release.visualProfileId,
        visualProfileVersion: release.visualProfileVersion,
        referenceSetRevisionId: release.referenceSetRevisionId,
        legacy: release.legacy,
      } : null,
    },
  };
}

function planTier(entitlements: Map<string, unknown>): string {
  const plan = record(entitlements.get("plan"));
  const slug = String(plan?.slug ?? "");
  if (slug.includes("deluxe") || jsonBoolean(entitlements.get("video_generation"))) return "deluxe";
  if (slug.includes("premium") || jsonBoolean(entitlements.get("premium_controls"))) return "premium";
  return "free";
}

function jsonBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
