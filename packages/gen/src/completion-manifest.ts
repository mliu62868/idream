import {
  durableAckSchema,
  generationManifestChecksum,
  generationCompletionManifestSchema,
  type GenerationCompletionManifest,
  type GenerationManifestIngest,
} from "@idream/shared/contracts";
import { env } from "./env";
import type { BlobStore } from "./providers";

export async function persistCompletionManifest(
  blob: BlobStore,
  manifest: GenerationCompletionManifest,
): Promise<GenerationManifestIngest> {
  const manifestChecksum = generationManifestChecksum(manifest);
  const manifestRef = completionManifestRef(manifest.attemptId);
  const persisted = await blob.putPrivate({
    key: manifestRef,
    body: new TextEncoder().encode(JSON.stringify(manifest)),
    contentType: "application/json",
  });
  if (!persisted.ok) throw new Error(persisted.error.message);
  return { manifestRef, manifestChecksum, manifest };
}

export async function loadPersistedCompletionManifest(
  blob: BlobStore,
  attemptId: string,
): Promise<GenerationManifestIngest | null> {
  if (!blob.getPrivate) return null;
  const loaded = await blob.getPrivate({ key: completionManifestRef(attemptId) });
  if (!loaded.ok) {
    if (loaded.error.code === "not_found") return null;
    throw new Error(loaded.error.message);
  }
  const manifest = generationCompletionManifestSchema.parse(
    JSON.parse(new TextDecoder().decode(loaded.data.body)),
  );
  return {
    manifestRef: completionManifestRef(attemptId),
    manifestChecksum: generationManifestChecksum(manifest),
    manifest,
  };
}

function completionManifestRef(attemptId: string): string {
  return `gen/completion-manifests/${attemptId}/completion.json`;
}

export async function acknowledgeCompletionManifest(input: GenerationManifestIngest): Promise<void> {
  const response = await fetch(env.MAIN_GENERATION_INGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`main generation ingest returned ${response.status}`);
  const ack = durableAckSchema.parse(await response.json());
  if (!ack.acknowledged) throw new Error(`main did not acknowledge ${input.manifest.attemptId}`);
}
