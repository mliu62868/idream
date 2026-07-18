import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  hasHydratableMediaBlobAuthority,
} from "@/server/lib/media-asset-authority";
import { canonicalSha256 } from "../shared/canonical-json";

export type CharacterImageAssetAuthorityInput = {
  readonly id: string;
  readonly ownerId: string;
  readonly characterId: string | null;
  readonly type: string;
  readonly url: string;
  readonly thumbnailUrl: string | null;
  readonly storageKey: string | null;
  readonly contentType: string | null;
  readonly visibility: string;
  readonly safetyStatus: string;
  readonly deletedAt: Date | string | null;
  readonly metadata: unknown;
};

export type CharacterImageAssetAuthority = {
  readonly id: string;
  readonly ownerId: string;
  readonly characterId: string | null;
  readonly type: string;
  readonly url: string;
  readonly thumbnailUrl: string | null;
  readonly storageKey: string | null;
  readonly contentType: string | null;
  readonly visibility: string;
  readonly safetyStatus: string;
  readonly deletedAt: string | null;
  readonly metadata: unknown;
  readonly bundledContentSha256: string | null;
};

export type BundledEditorialImage = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly extension: string;
  readonly contentSha256: string;
};

export type CharacterImageReadinessFingerprintInput = {
  readonly characterId: string;
  readonly characterImageAssetId: string | null;
  readonly sourceAsset: CharacterImageAssetAuthority | null;
  readonly projectId: string;
  readonly projectVersion: number;
  readonly draftImageAssetId: string | null;
  readonly draftAssetPack: unknown;
  readonly serving: {
    readonly currentReleaseId: string | null;
    readonly scheduledReleaseId: string | null;
    readonly version: number;
  } | null;
  readonly currentRelease: {
    readonly id: string;
    readonly version: number;
    readonly snapshotHash: string;
  } | null;
  readonly activeIdentity: {
    readonly id: string;
    readonly version: number;
    readonly immutableHash: string | null;
  } | null;
  readonly activeReferenceSet: {
    readonly id: string;
    readonly revision: number;
    readonly snapshotHash: string | null;
  } | null;
};

const BUNDLED_EDITORIAL_IMAGE_PREFIX = "/images/ourdream/";

export function characterImageAssetAuthority(
  asset: CharacterImageAssetAuthorityInput,
  bundledContentSha256: string | null,
): CharacterImageAssetAuthority {
  return {
    id: asset.id,
    ownerId: asset.ownerId,
    characterId: asset.characterId,
    type: asset.type,
    url: asset.url,
    thumbnailUrl: asset.thumbnailUrl,
    storageKey: asset.storageKey,
    contentType: asset.contentType,
    visibility: asset.visibility,
    safetyStatus: asset.safetyStatus,
    deletedAt: asset.deletedAt instanceof Date
      ? asset.deletedAt.toISOString()
      : asset.deletedAt,
    metadata: asset.metadata,
    bundledContentSha256,
  };
}

export async function inspectCharacterImageGenerationSource(
  asset: CharacterImageAssetAuthorityInput,
) {
  if (hasHydratableMediaBlobAuthority(asset)) {
    return {
      authority: characterImageAssetAuthority(asset, null),
      materializable: true,
      bundled: null,
    } as const;
  }
  const bundled = await readBundledEditorialImage(asset.url);
  return {
    authority: characterImageAssetAuthority(
      asset,
      bundled?.contentSha256 ?? null,
    ),
    materializable: bundled !== null,
    bundled,
  } as const;
}

async function readBundledEditorialImage(
  urlValue: string,
): Promise<BundledEditorialImage | null> {
  const value = urlValue.trim();
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, "https://idream.invalid");
  } catch {
    return null;
  }
  if (parsed.search || parsed.hash) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (!pathname.startsWith(BUNDLED_EDITORIAL_IMAGE_PREFIX)) return null;
  const extension = path.extname(pathname).toLowerCase();
  const contentType = bundledImageContentType(extension);
  if (!contentType) return null;
  const relativePath = pathname.slice(
    BUNDLED_EDITORIAL_IMAGE_PREFIX.length,
  );
  const publicRoot = path.join(
    process.cwd(),
    "public",
    "images",
    "ourdream",
  );
  const candidate = path.join(publicRoot, relativePath);
  if (
    candidate === publicRoot ||
    !candidate.startsWith(`${publicRoot}${path.sep}`)
  ) {
    return null;
  }
  try {
    const bytes = new Uint8Array(await readFile(candidate));
    if (bytes.byteLength > 0) {
      return {
        bytes,
        contentType,
        extension,
        contentSha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }
  } catch {
    // The package cwd is pinned in dev, tests, and standalone runtime. A
    // missing packaged file is therefore an actual materialization block.
  }
  return null;
}

function bundledImageContentType(extension: string) {
  if (extension === ".webp") return "image/webp";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return null;
}

export function characterImageReadinessFingerprint(
  input: CharacterImageReadinessFingerprintInput,
) {
  return canonicalSha256(input);
}
