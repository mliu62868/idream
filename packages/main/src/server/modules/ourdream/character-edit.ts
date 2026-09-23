import { loadCharacterSoulSnapshot } from "@idream/shared/chat/persona";
import type { CharacterDraft, Prisma } from "@prisma/client";
import { ensureCustomerCharacterPublicationPrep } from "@/server/modules/admin-v2/characters/publication-prep";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { canonicalJsonEqual } from "@/server/modules/admin-v2/shared/idempotency";
import { prisma } from "@/server/lib/db";
import { AppError, Errors } from "@/server/lib/errors";
import { isRecord, toInputJson } from "@/server/lib/request-json";
import { logger } from "@/server/lib/logger";
import { moderateText } from "@/server/moderation/text-authority";
import { jsonNonBlankString, jsonRecord, jsonStringArray } from "./json-values";
import { assertCharacterIdentityAuthorityMutable } from "./generation-character-authority";
import { createActiveCharacterVisualProfileVersion } from "./generation-reference-set";
import { assertIdentityImageMediaInTx, assertNonSyntheticMediaAsset } from "./customer-media-authority";
import {
  compileUserSoulOrBadRequest,
  loadCurrentCharacterContentSnapshot,
  materializeUserCharacterContentVersion,
} from "./character-soul";
import { readCurrentCharacterDraftDetails } from "./character-draft-details";
import {
  bindCharacterDraftVoice,
  cleanupPreparedCharacterDraftVoice,
  prepareCharacterDraftVoice,
} from "./character-draft-voice";
import { updateCharacterForUser } from "./character-update";

// SPEC: CR-06 owner edit. "Edit" derives a CharacterDraft (editsCharacterId) from
// the Character's pinned Soul, opening, appearance, tags and voice; the Create
// wizard edits it; submit appends versions to the same Character.
//
// INVARIANT (CR-08): nothing already written is rewritten. Submit appends one
// CharacterContentVersion and one active CharacterVisualProfile version; every
// earlier ChatTurn keeps its own content/visual pin. Only the owner's active,
// Release-less sessions move to the new pin, so their next Turn uses the edit.
//
// SPEC: a Character with Release authority (published, or paused after
// publishing) takes a Soul/opening/tag edit as a new publication revision:
// one CharacterContentVersion plus one CharacterRevision in its project. The
// serving Release keeps serving; the existing Release executor publishes the
// revision and projects its content onto the Character (supersede).
// INVARIANT: that path never writes Release-owned Character columns, Visual
// Identity or the voice pointer. Visual Identity stays locked by
// assertCharacterIdentityAuthorityMutable, and voice is not Release-versioned,
// so changing either on a published Character is refused rather than applied
// to the live version.

const PUBLISHED_LOOK_LOCKED =
  "A published character keeps its current look. Undo the appearance changes to save, or duplicate the character to change how it looks.";
const PUBLISHED_VOICE_LOCKED =
  "A published character keeps its current voice. Choose the current voice to save, or duplicate the character to change it.";

/** True when a Release pins this Character's identity (serving pointer or approved Release). */
async function hasReleaseAuthority(tx: Prisma.TransactionClient, characterId: string) {
  try {
    await assertCharacterIdentityAuthorityMutable(tx, characterId);
    return false;
  } catch (error) {
    if (error instanceof AppError && error.code === "conflict") return true;
    throw error;
  }
}

/** A published Character's newest authored Soul is its latest project revision. */
async function latestRevisionContentVersionId(tx: Prisma.TransactionClient, characterId: string) {
  const revision = await tx.characterRevision.findFirst({
    where: { projectId: { in: (await tx.characterProject.findMany({ where: { characterId }, select: { id: true } })).map((project) => project.id) } },
    orderBy: [{ createdAt: "desc" }, { revision: "desc" }],
    select: { characterContentVersionId: true },
  });
  return revision?.characterContentVersionId ?? null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function pickText(value: unknown, ...keys: string[]) {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";
  for (const key of keys) {
    const found = text(value[key]);
    if (found) return found;
  }
  return Object.entries(value)
    .filter(([, trait]) => (typeof trait === "string" && trait.trim()) || typeof trait === "number")
    .map(([key, trait]) => `${key}: ${trait}`)
    .join(", ");
}

/**
 * The wizard reads and writes a flat projection of appearance
 * (face fields + hair.prompt + body.type). Projecting the stored appearance the
 * same way lets submit tell a real visual edit from a round trip through the form.
 */
export function wizardVisualProjection(appearance: unknown) {
  const root = jsonRecord(appearance);
  const face = isRecord(root.face) ? root.face : root;
  const compact = (value: Record<string, string>) =>
    Object.fromEntries(Object.entries(value).filter(([, trait]) => trait));
  return {
    appearance: compact({
      prompt: text(face.prompt) || text(face.summary),
      ethnicity: text(face.ethnicity) || text(face.race),
      skinTone: text(face.skinTone),
      eyes: text(face.eyes) || text(face.eyeColor),
      faceShape: text(face.faceShape),
    }),
    hair: compact({ prompt: pickText(root.hair, "prompt", "summary") }),
    body: compact({ type: pickText(root.body, "type", "prompt", "summary") }),
  };
}

function draftVisualProjection(draft: CharacterDraft) {
  const compact = (value: unknown) =>
    Object.fromEntries(Object.entries(jsonRecord(value))
      .map(([key, trait]) => [key, text(trait)] as const)
      .filter(([, trait]) => trait));
  return {
    appearance: compact(draft.appearance),
    hair: compact(draft.hair),
    body: compact(draft.body),
  };
}

async function currentPresetVoiceId(voiceId: string | null) {
  if (!voiceId) return null;
  const profile = await prisma.characterVoiceProfile.findUnique({
    where: { providerVoiceId: voiceId },
    select: { provider: true, referenceAsset: { select: { metadata: true } } },
  });
  if (profile?.provider !== "pocket_tts") return null;
  return jsonNonBlankString(jsonRecord(profile.referenceAsset.metadata).presetVoiceId);
}

async function editableCharacter(userId: string, characterId: string) {
  const character = await prisma.character.findFirst({
    where: { id: characterId, creatorId: userId, deletedAt: null },
    include: { tags: { select: { tag: { select: { slug: true } } } } },
  });
  if (!character) throw Errors.notFound("Character not found");
  return character;
}

/** Returns the owner's open edit draft for this Character, or derives a new one. */
export async function openCharacterEditDraft(input: {
  readonly userId: string;
  readonly characterId: string;
}) {
  const { userId, characterId } = input;
  const character = await editableCharacter(userId, characterId);
  const published = await hasReleaseAuthority(prisma, characterId);
  const open = await prisma.characterDraft.findFirst({
    where: { ownerId: userId, editsCharacterId: characterId },
    orderBy: { updatedAt: "desc" },
  });
  if (open && !readCurrentCharacterDraftDetails(open.advancedDetails).submittedCharacterId) {
    return { draft: open, character, published };
  }
  // A pending (not yet published) revision is what the owner last saved.
  const content = await loadCurrentCharacterContentSnapshot(
    prisma,
    character.id,
    (published ? await latestRevisionContentVersionId(prisma, characterId) : null) ?? character.currentContentVersionId,
  );
  const soul = content ? loadCharacterSoulSnapshot(content.personaSnapshot) : null;
  if (soul && !soul.ok) {
    throw Errors.conflict("This character's saved Soul can't be opened for editing");
  }
  const legacy = readCurrentCharacterDraftDetails(character.advancedDetails);
  const firstMessage = content
    ? text(jsonRecord(content.openingSnapshot).firstMessage)
    : legacy.firstMessage ?? "";
  const presetVoiceId = await currentPresetVoiceId(character.voiceId);
  const visual = wizardVisualProjection(character.appearance);
  const draft = await prisma.characterDraft.create({
    data: {
      ownerId: userId,
      editsCharacterId: character.id,
      step: 0,
      name: soul?.ok ? soul.snapshot.soul.name : character.name,
      gender: character.gender,
      style: character.style,
      appearance: toInputJson(visual.appearance),
      hair: toInputJson(visual.hair),
      body: toInputJson(visual.body),
      advancedDetails: toInputJson({
        age: soul?.ok ? soul.snapshot.soul.age : character.age,
        description: soul?.ok ? soul.snapshot.soul.characterPromise : character.description,
        detailsMarkdown: soul?.ok ? soul.snapshot.soul.detailsMarkdown : legacy.detailsMarkdown ?? "",
        firstMessage,
        ...(presetVoiceId ? { voiceSelection: { provider: "pocket_tts", voiceId: presetVoiceId } } : {}),
      }),
      tags: toInputJson(character.tags.map(({ tag }) => tag.slug)),
    },
  });
  return { draft, character, published };
}

/**
 * Applies a submitted edit draft to its Character. Called by submitCharacterDraft
 * after its replay check, so a repeated submit returns the already-edited Character.
 */
export async function applyCharacterEditDraft(input: {
  readonly userId: string;
  readonly draft: CharacterDraft & { editsCharacterId: string };
  readonly visibility: "private" | "unlisted" | "public";
}) {
  const { userId, draft } = input;
  const characterId = draft.editsCharacterId;
  const before = await editableCharacter(userId, characterId);
  const details = readCurrentCharacterDraftDetails(draft.advancedDetails);
  const name = draft.name ?? "";
  const age = details.age;
  const description = jsonNonBlankString(details.description) ?? "";
  const firstMessage = jsonNonBlankString(details.firstMessage);
  const style = draft.style ?? before.style ?? "realistic";
  const gender = draft.gender ?? before.gender ?? "female";
  if (!name) throw Errors.badRequest("Draft name is required before submit");
  if (age === undefined || !description || !firstMessage) {
    throw Errors.badRequest("Complete the character persona before publishing", {
      missingFields: [
        ...(age === undefined ? ["age"] : []),
        ...(description ? [] : ["description"]),
        ...(firstMessage ? [] : ["firstMessage"]),
      ],
    });
  }
  const moderation = await moderateText(
    "character_draft",
    draft.id,
    `${name} ${description} ${JSON.stringify(draft.advancedDetails)}`,
    "input",
  );
  if (moderation.status === "blocked") throw Errors.forbidden("Character failed safety checks", moderation);

  const visualChanged =
    style !== before.style ||
    gender !== before.gender ||
    age !== before.age ||
    !canonicalJsonEqual(draftVisualProjection(draft), wizardVisualProjection(before.appearance));
  const previousPresetVoiceId = await currentPresetVoiceId(before.voiceId);
  const voiceChanged = Boolean(details.voiceSelection && details.voiceSelection.voiceId !== previousPresetVoiceId);
  if (await hasReleaseAuthority(prisma, characterId)) {
    if (visualChanged || draft.previewJobId) throw Errors.conflict(PUBLISHED_LOOK_LOCKED);
    if (voiceChanged) throw Errors.conflict(PUBLISHED_VOICE_LOCKED);
    return submitPublishedCharacterRevision({ userId, draft, before, name, age, description, style, gender, details });
  }
  const selectedPreview = draft.previewJobId
    ? await prisma.characterPreviewJob.findFirst({
        where: { id: draft.previewJobId, draftId: draft.id, status: "completed", resultAssetId: { not: null } },
      })
    : null;
  const anchorAssetId = selectedPreview?.resultAssetId ?? null;
  // INVARIANT: a new appearance never ships with the old face. Unchanged traits
  // keep the confirmed identity; changed traits need a newly confirmed image.
  if (visualChanged && !anchorAssetId) {
    throw Errors.badRequest("Choose an identity image before publishing this character");
  }
  const appearance = visualChanged || anchorAssetId
    ? (() => {
        const visual = draftVisualProjection(draft);
        return {
          ...visual.appearance,
          ...(Object.keys(visual.hair).length ? { hair: visual.hair } : {}),
          ...(Object.keys(visual.body).length ? { body: visual.body } : {}),
        };
      })()
    : before.appearance;
  const userContent = compileUserSoulOrBadRequest({
    name,
    age,
    description,
    style,
    gender,
    appearance,
    advancedDetails: details,
  });

  // Clearing the selection keeps the current voice; the wizard only offers a replacement.
  const preparedVoice = voiceChanged && details.voiceSelection
    ? await prepareCharacterDraftVoice({ ...details.voiceSelection, userId, draftId: draft.id })
    : null;

  const character = await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, characterId);
    const existing = await tx.character.findFirst({ where: { id: characterId, creatorId: userId, deletedAt: null } });
    if (!existing) throw Errors.notFound("Character not found");
    // A Release may have been prepared since the pre-check; its identity lock wins.
    if (await hasReleaseAuthority(tx, characterId)) throw Errors.conflict(PUBLISHED_LOOK_LOCKED);
    if (anchorAssetId) {
      await lockCharacterMediaAssetAuthorities(tx, [anchorAssetId]);
      const anchor = await assertIdentityImageMediaInTx(tx, anchorAssetId, userId);
      assertNonSyntheticMediaAsset(anchor, "Demo preview images cannot be published as a character identity");
      if (anchor.characterId !== null && anchor.characterId !== characterId) {
        throw Errors.conflict("The selected identity image already belongs to another Character.");
      }
      await tx.mediaAsset.update({ where: { id: anchorAssetId }, data: { characterId } });
    }
    const contentVersion = await materializeUserCharacterContentVersion({
      tx,
      characterId,
      sourceId: draft.id,
      createdById: userId,
      content: userContent,
    });
    if (preparedVoice) {
      const latestVoice = await tx.characterVoiceProfile.findFirst({
        where: { characterId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      await tx.characterVoiceProfile.updateMany({
        where: { characterId, status: "active" },
        data: { status: "archived", archivedAt: new Date() },
      });
      await bindCharacterDraftVoice(tx, {
        characterId,
        userId,
        prepared: preparedVoice,
        replacesVoiceId: existing.voiceId,
        version: (latestVoice?.version ?? 0) + 1,
      });
    }
    const updated = await tx.character.update({
      where: { id: characterId },
      data: {
        name,
        age,
        gender,
        style,
        description,
        appearance: toInputJson(appearance),
        advancedDetails: toInputJson({
          detailsMarkdown: details.detailsMarkdown ?? "",
          firstMessage,
          soulFingerprint: userContent.personaSnapshot.compiled.fingerprint,
          compilerVersion: userContent.personaSnapshot.compiled.compilerVersion,
        }),
        systemPrompt: userContent.personaSnapshot.compiled.systemPrompt,
        currentContentVersionId: contentVersion.id,
        ...(anchorAssetId ? { imageAssetId: anchorAssetId } : {}),
      },
    });
    const visualProfile = await createActiveCharacterVisualProfileVersion(tx, updated, {
      createdFrom: anchorAssetId ? "character_edit_preview" : "character_edit",
      ...(anchorAssetId ? { anchorAssetIds: [anchorAssetId] } : {}),
    });
    // Tags are discovery dimensions, not versioned content; same dictionary rule as create.
    const tagSlugs = jsonStringArray(draft.tags);
    const knownTags = tagSlugs.length
      ? await tx.tag.findMany({ where: { slug: { in: tagSlugs } }, select: { id: true } })
      : [];
    await tx.characterTag.deleteMany({ where: { characterId } });
    if (knownTags.length) {
      await tx.characterTag.createMany({
        data: knownTags.map((tag) => ({ characterId, tagId: tag.id })),
        skipDuplicates: true,
      });
    }
    // Owner sessions without a Release pin follow the owner's latest version.
    // Turns carry their own pins, so earlier messages keep the Soul they used.
    await tx.recentChat.updateMany({
      where: { userId, characterId, status: "active", characterReleaseId: null },
      data: {
        characterContentVersionId: contentVersion.id,
        characterVisualProfileId: visualProfile.id,
        characterVisualProfileVersion: visualProfile.version,
      },
    });
    // A shared Character still in publication preparation must prepare the
    // version the owner just saved, not the one it was submitted with.
    if (updated.visibility !== "private" && updated.status === "approved") {
      const submission = await tx.characterSubmission.findFirst({
        where: { characterId, status: "approved" },
        orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      if (submission) {
        await ensureCustomerCharacterPublicationPrep(tx, { characterId, submissionId: submission.id, actorId: userId });
      }
    }
    await tx.characterDraft.update({
      where: { id: draft.id },
      data: { advancedDetails: toInputJson({ ...details, age, submittedCharacterId: characterId }) },
    });
    return updated;
  }).catch(async (error) => {
    if (preparedVoice) {
      await cleanupPreparedCharacterDraftVoice(preparedVoice).catch((cleanupError) => {
        logger.error({ err: cleanupError, draftId: draft.id }, "Could not clean up a prepared Character voice after edit failure");
      });
    }
    throw error;
  });

  if (input.visibility !== character.visibility) {
    // Visibility has its own publication rules; reuse them instead of copying.
    await updateCharacterForUser({ userId, characterId, patch: { visibility: input.visibility } });
    return { character: await prisma.character.findUniqueOrThrow({ where: { id: characterId } }), pendingPublication: false };
  }
  return { character, pendingPublication: false };
}

async function submitPublishedCharacterRevision(input: {
  readonly userId: string;
  readonly draft: CharacterDraft & { editsCharacterId: string };
  readonly before: { appearance: Prisma.JsonValue };
  readonly name: string;
  readonly age: number;
  readonly description: string;
  readonly style: string;
  readonly gender: string;
  readonly details: ReturnType<typeof readCurrentCharacterDraftDetails>;
}) {
  const { userId, draft } = input;
  const characterId = draft.editsCharacterId;
  const userContent = compileUserSoulOrBadRequest({
    name: input.name,
    age: input.age,
    description: input.description,
    style: input.style,
    gender: input.gender,
    appearance: input.before.appearance,
    advancedDetails: input.details,
  });
  const character = await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, characterId);
    const existing = await tx.character.findFirst({ where: { id: characterId, creatorId: userId, deletedAt: null } });
    if (!existing) throw Errors.notFound("Character not found");
    const project = await tx.characterProject.findFirst({
      where: { characterId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (!project) throw Errors.conflict("This character's publication project is unavailable");
    const contentVersion = await materializeUserCharacterContentVersion({
      tx,
      characterId,
      sourceId: draft.id,
      createdById: userId,
      content: userContent,
    });
    const latest = await tx.characterRevision.findFirst({
      where: { projectId: project.id },
      orderBy: [{ revision: "desc" }, { id: "desc" }],
      select: { revision: true, characterContentVersionId: true },
    });
    // Release preparation reads the project's newest revision.
    if (latest?.characterContentVersionId !== contentVersion.id) {
      await tx.characterRevision.create({
        data: {
          projectId: project.id,
          revision: (latest?.revision ?? 0) + 1,
          characterContentVersionId: contentVersion.id,
          projectSnapshot: toInputJson({
            schemaVersion: "customer-character-edit-revision-v1",
            source: "customer_edit",
            draftId: draft.id,
            contentVersion: contentVersion.version,
          }),
          createdById: userId,
        },
      });
    }
    // Tags are catalog dimensions, not Release content; same dictionary rule as create.
    const tagSlugs = jsonStringArray(draft.tags);
    const knownTags = tagSlugs.length
      ? await tx.tag.findMany({ where: { slug: { in: tagSlugs } }, select: { id: true } })
      : [];
    await tx.characterTag.deleteMany({ where: { characterId } });
    if (knownTags.length) {
      await tx.characterTag.createMany({
        data: knownTags.map((tag) => ({ characterId, tagId: tag.id })),
        skipDuplicates: true,
      });
    }
    await tx.characterDraft.update({
      where: { id: draft.id },
      data: { advancedDetails: toInputJson({ ...input.details, age: input.age, submittedCharacterId: characterId }) },
    });
    return existing;
  });
  return { character, pendingPublication: true };
}
