// SPEC: Character publishing is an immutable Release plus one Serving pointer.
// Operators create and publish a Release in one action; technical checks remain
// internal evidence and are never a separate review or QA workflow.

import { z } from "zod";
import {
  adminCommandRequestSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
} from "./common";
import { characterServingStateSchema } from "./characters-common";

export const characterReleasePublishCommandRequestSchema =
  adminCommandRequestSchema;

// The URL identifies the immutable historical Release; entityVersion is the
// CharacterServing version because rollback swaps that authority pointer.
export const characterReleaseRollbackCommandRequestSchema =
  adminCommandRequestSchema;

export const characterSessionReleaseMigrationCommandRequestSchema =
  adminCommandRequestSchema.extend({
    characterId: adminIdSchema,
    fromCharacterContentVersionId: adminIdSchema.nullable(),
    fromCharacterReleaseId: adminIdSchema.nullable(),
    toCharacterContentVersionId: adminIdSchema,
    toCharacterReleaseId: adminIdSchema,
    compatibilityCheck: z
      .object({
        status: z.literal("passed"),
        policyVersion: z.string().trim().min(1),
        evidence: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  });

export const characterReleaseStatusSchema = z.enum([
  "approved",
  "published",
  "superseded",
  "withdrawn",
]);

export const characterContentVersionRefSchema = z
  .object({
    id: adminIdSchema,
    version: z.number().int().positive(),
    contentHash: z.string().trim().min(1),
  })
  .strict();

export const characterVisualIdentityRefSchema = z
  .object({
    visualProfileId: adminIdSchema,
    visualProfileVersion: z.number().int().positive(),
    anchorAssetId: adminIdSchema,
    referenceSetRevisionId: adminIdSchema,
  })
  .strict();

export const generationRouteRefSchema = z
  .object({
    generationProfileKey: z.string().trim().min(1),
    generationProfileVersion: z.string().trim().min(1),
    workflowKey: z.string().trim().min(1),
    workflowVersion: z.string().trim().min(1),
  })
  .strict();

export const releaseOwnedPlacementSchema = z
  .object({
    slotKey: z.string().trim().min(1),
    slotVersion: z.number().int().positive(),
    assetId: adminIdSchema,
  })
  .strict();

export const characterReleaseSchema = z
  .object({
    id: adminIdSchema,
    projectId: adminIdSchema,
    revisionId: adminIdSchema,
    characterContentVersionId: adminIdSchema,
    visualIdentity: characterVisualIdentityRefSchema,
    generationRoute: generationRouteRefSchema,
    releaseOwnedPlacements: z.array(releaseOwnedPlacementSchema).readonly(),
    snapshotHash: z.string().trim().min(1),
    policyVersion: z.string().trim().min(1),
    legacy: z.boolean(),
    status: characterReleaseStatusSchema,
    publishedAt: adminIsoDateTimeSchema.nullable(),
    supersedesId: adminIdSchema.nullable(),
    rollbackOfReleaseId: adminIdSchema.nullable(),
    version: z.number().int().nonnegative(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict()
  .superRefine((release, ctx) => {
    if (
      release.status === "published" &&
      !release.legacy &&
      release.publishedAt === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "Published releases need publishedAt",
      });
    }
  });

export const characterServingSchema = z
  .object({
    characterId: adminIdSchema,
    state: characterServingStateSchema,
    currentReleaseId: adminIdSchema.nullable(),
    version: z.number().int().nonnegative(),
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterReleaseCheckSchema = z
  .object({
    checkKey: z.string().trim().min(1),
    result: z.enum(["passed", "failed", "blocked", "stale"]),
    evidence: z.record(z.string(), z.unknown()),
    checkedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterReleaseCreateRequestSchema = z
  .object({
    entityVersion: z.number().int().positive(),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1),
  })
  .strict();

export const characterReleaseMonitorSchema = z
  .object({
    id: adminIdSchema,
    window: z.string().trim().min(1),
    status: z.string().trim().min(1),
    baseline: z.record(z.string(), z.unknown()),
    observed: z.record(z.string(), z.unknown()),
    verification: z.record(z.string(), z.unknown()),
    startedAt: adminIsoDateTimeSchema,
    finishedAt: adminIsoDateTimeSchema.nullable(),
  })
  .strict();

export const characterWorkspaceReleaseSchema = z
  .object({
    release: z
      .object({
        id: adminIdSchema,
        projectId: adminIdSchema,
        revisionId: adminIdSchema,
        characterContentVersionId: adminIdSchema,
        visualProfileId: adminIdSchema.nullable(),
        visualProfileVersion: z.number().int().positive().nullable(),
        referenceSetRevisionId: adminIdSchema.nullable(),
        generationProvenance: z.record(z.string(), z.unknown()),
        releasePlacementManifest: z.record(z.string(), z.unknown()),
        snapshotHash: z.string().trim().min(1),
        readiness: z.string().trim().min(1),
        legacy: z.boolean(),
        status: characterReleaseStatusSchema,
        publishedAt: adminIsoDateTimeSchema.nullable(),
        supersedesId: adminIdSchema.nullable(),
        rollbackOfReleaseId: adminIdSchema.nullable(),
        version: z.number().int().nonnegative(),
        createdAt: adminIsoDateTimeSchema,
        updatedAt: adminIsoDateTimeSchema,
      })
      .strict(),
    checks: z.array(characterReleaseCheckSchema).readonly(),
    monitors: z.array(characterReleaseMonitorSchema).readonly(),
  })
  .strict();

export const characterReleaseMonitorRefreshRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
  })
  .strict();

export const characterReleaseMonitorRefreshResultSchema = z
  .object({
    releaseId: adminIdSchema,
    window: z.enum(["24h", "72h"]),
    status: z.string().trim().min(1),
    mature: z.boolean(),
    recommendation: z.string().trim().min(1),
    observed: z.record(z.string(), z.unknown()),
  })
  .strict();

export type CharacterRelease = z.infer<typeof characterReleaseSchema>;
export type CharacterServing = z.infer<typeof characterServingSchema>;
export type CharacterReleaseCreateRequest = z.infer<
  typeof characterReleaseCreateRequestSchema
>;
export type CharacterReleasePublishCommandRequest = z.infer<
  typeof characterReleasePublishCommandRequestSchema
>;
export type CharacterReleaseRollbackCommandRequest = z.infer<
  typeof characterReleaseRollbackCommandRequestSchema
>;
export type CharacterSessionReleaseMigrationCommandRequest = z.infer<
  typeof characterSessionReleaseMigrationCommandRequestSchema
>;
