import type { Prisma } from "@prisma/client";
import { workflowDescriptorSchema } from "@idream/shared/gen-workflow";
import { describe, expect, it, vi } from "vitest";
import {
  discoverDraftAssetPackSourceAssetIds,
  draftAssetSourceRuntimeAuthority,
  partitionedReferenceManifestAuthority,
} from "./draft-asset-pack-authority";

describe("draft asset pack Reference manifest authority", () => {
  it("uses the complete workflow descriptor for More-like slot authority", () => {
    const workflow = workflowDescriptorSchema.parse({
      workflowKey: "draft-source-runtime",
      modelId: "draft-source-runtime",
      backendKind: "comfyui",
      comfyWorkflow: {
        id: "77777777-7777-4777-8777-777777777777",
        name: "Draft Source Runtime",
      },
      version: 1,
      capabilities: ["referenceImages"],
      identity: {
        mode: "multi_reference",
        maxReferences: 2,
        acceptedRoles: [
          "identity_anchor",
          "identity_reference",
          "source_image",
        ],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: true,
      },
      quality: {
        maxCandidates: 1,
        evaluatorDimensions: ["artifact"],
      },
      apiPrompt: {
        "8": { class_type: "LoadImage", inputs: { image: "" } },
        "9": { class_type: "LoadImage", inputs: { image: "" } },
      },
      inputs: [
        {
          key: "identity_image",
          type: "image",
          referenceRoles: ["identity_anchor", "identity_reference"],
          target: { nodeId: "8", field: "image" },
        },
        {
          key: "source_image",
          type: "image",
          referenceRoles: ["source_image"],
          target: { nodeId: "9", field: "image" },
        },
      ],
    });
    const supportedRoute = {
      sourceReferenceCount: 1,
      pinnedReferenceCount: 2,
      canonicalReferenceRoles: ["identity_anchor"],
      workflow,
      profileSupportsReferenceImages: true,
      profileSupportsInitImage: true,
    };

    expect(draftAssetSourceRuntimeAuthority({
      ...supportedRoute,
    })).toBe(true);
    expect(draftAssetSourceRuntimeAuthority({
      ...supportedRoute,
      sourceReferenceCount: 0,
      pinnedReferenceCount: 1,
    })).toBe(false);
    expect(draftAssetSourceRuntimeAuthority({
      ...supportedRoute,
      pinnedReferenceCount: 3,
      canonicalReferenceRoles: [
        "identity_reference",
        "identity_reference",
      ],
    })).toBe(false);
    expect(draftAssetSourceRuntimeAuthority({
      ...supportedRoute,
      workflow: null,
    })).toBe(false);
  });

  it("discovers every unique More-like source before the shared lock set is acquired", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        job: {
          referenceManifest: [
            { mediaAssetId: "identity-anchor", role: "primary_face" },
            { mediaAssetId: "source-b", role: "source_image" },
          ],
        },
      },
      {
        job: {
          referenceManifest: [
            { mediaAssetId: "source-a", role: "source_image" },
            { mediaAssetId: "source-b", role: "source_image" },
          ],
        },
      },
    ]);
    const tx = {
      contentProductionItem: { findMany },
    } as unknown as Pick<Prisma.TransactionClient, "contentProductionItem">;

    await expect(discoverDraftAssetPackSourceAssetIds(tx, {
      character_cover: {
        assetId: "cover",
        itemId: "item-cover",
      },
      character_hero: {
        assetId: "hero",
        itemId: "item-hero",
      },
    })).resolves.toEqual(["source-a", "source-b"]);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ["item-cover", "item-hero"] } },
      select: {
        job: {
          select: { referenceManifest: true },
        },
      },
    });
  });

  it("keeps canonical Reference Set equality separate from a pinned More-like source", () => {
    const result = partitionedReferenceManifestAuthority({
      pinnedReferenceAssetIds: ["canonical-anchor", "approved-source"],
      canonicalReferenceAssetIds: ["canonical-anchor"],
      referenceSetRevisionId: "reference-set-1",
      referenceSetSnapshotHash: "reference-hash-1",
      manifestEntries: [{
        mediaAssetId: "canonical-anchor",
        role: "primary_face",
        referenceSetRevisionId: "reference-set-1",
        snapshotHash: "reference-hash-1",
      }, {
        mediaAssetId: "approved-source",
        role: "source_image",
        sourceJobId: "source-job-1",
        referenceSetRevisionId: "reference-set-1",
        snapshotHash: "reference-hash-1",
      }],
    });

    expect(result.matches).toBe(true);
    expect(result.sourceEntries).toEqual([
      expect.objectContaining({
        mediaAssetId: "approved-source",
        role: "source_image",
      }),
    ]);
  });

  it("does not allow a More-like source to replace a canonical identity reference", () => {
    expect(partitionedReferenceManifestAuthority({
      pinnedReferenceAssetIds: ["approved-source"],
      canonicalReferenceAssetIds: ["canonical-anchor"],
      referenceSetRevisionId: "reference-set-1",
      referenceSetSnapshotHash: "reference-hash-1",
      manifestEntries: [{
        mediaAssetId: "approved-source",
        role: "source_image",
        sourceJobId: "source-job-1",
        referenceSetRevisionId: "reference-set-1",
        snapshotHash: "reference-hash-1",
      }],
    }).matches).toBe(false);
  });
});
