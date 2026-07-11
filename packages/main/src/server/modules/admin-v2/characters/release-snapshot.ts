import { canonicalSha256 } from "../shared/canonical-json";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(
        new Set(
          value.filter((item): item is string => typeof item === "string"),
        ),
      ).sort()
    : [];
}

export function characterVisualProfileSnapshotHash(profile: {
  readonly version: number;
  readonly style: string;
  readonly identityPrompt: string;
  readonly negativeIdentityPrompt: string | null;
  readonly faceTraits: unknown;
  readonly hairTraits: unknown;
  readonly bodyTraits: unknown;
  readonly signatureTraits: unknown;
  readonly styleTraits: unknown;
  readonly anchorAssetIds: unknown;
  readonly referenceAssetIds: unknown;
}) {
  return canonicalSha256({
    version: profile.version,
    style: profile.style,
    identityPrompt: profile.identityPrompt,
    negativeIdentityPrompt: profile.negativeIdentityPrompt,
    traits: {
      face: profile.faceTraits,
      hair: profile.hairTraits,
      body: profile.bodyTraits,
      signature: profile.signatureTraits,
      style: profile.styleTraits,
    },
    anchorAssetIds: stringArray(profile.anchorAssetIds),
    referenceAssetIds: stringArray(profile.referenceAssetIds),
  });
}

export function referenceSetSnapshotHash(input: {
  readonly visualProfileId: string;
  readonly revision: number;
  readonly selectorVersion: string;
  readonly references: readonly {
    readonly mediaAssetId: string;
    readonly position: number;
    readonly role: string;
    readonly weight: number;
  }[];
}) {
  return canonicalSha256({
    visualProfileId: input.visualProfileId,
    revision: input.revision,
    selectorVersion: input.selectorVersion,
    references: input.references.map((item) => ({
      mediaAssetId: item.mediaAssetId,
      position: item.position,
      role: item.role,
      weight: item.weight,
    })),
  });
}

export function characterReleaseSnapshotHash(input: {
  readonly projectId: string;
  readonly revisionId: string;
  readonly characterContentVersionId: string;
  readonly visualProfileId: string | null;
  readonly visualProfileVersion: number | null;
  readonly referenceSetRevisionId: string | null;
  readonly generationProvenance: unknown;
  readonly releasePlacementManifest: unknown;
}) {
  return canonicalSha256(input);
}
