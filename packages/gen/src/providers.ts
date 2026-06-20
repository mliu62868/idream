// SPEC: Self-contained provider mocks for the generation service — image model,
// video model, and a private blob store. Ported from packages/main providers,
// stripped of Next/Prisma. gen is the slow async tier: generate → write blob.
// INTENT: Keep the exact result-envelope shape (ProviderResult) main uses so the
// pipeline logic ports 1:1. Only the "mock" backend is wired; other backends
// throw (mirrors main, which only ships mock today).
// INVARIANTS: blob.putPrivate is the ONLY persistence gen performs. No DB.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

export interface ProviderFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export type ProviderResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ProviderFailure };

export interface ImageModel {
  generate(input: {
    prompt: string;
    count: number;
    seed?: string;
  }): Promise<ProviderResult<{ assets: Array<{ key: string; width: number; height: number }> }>>;
}

export interface VideoModel {
  generate(input: {
    prompt: string;
    seconds: number;
    seed?: string;
  }): Promise<ProviderResult<{ asset: { key: string; seconds: number } }>>;
}

export interface BlobStore {
  putPrivate(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<ProviderResult<{ key: string; size: number }>>;
  signGetUrl(input: { key: string; expiresInSeconds: number }): Promise<ProviderResult<{ url: string }>>;
}

class MockImageModel implements ImageModel {
  async generate(input: Parameters<ImageModel["generate"]>[0]) {
    const count = Math.max(1, Math.min(input.count, 4));
    const seed = input.seed ?? "mock";
    return {
      ok: true as const,
      data: {
        assets: Array.from({ length: count }, (_, index) => ({
          key: `mock/images/${seed}-${index + 1}.png`,
          width: 1024,
          height: 1024,
        })),
      },
    };
  }
}

class MockVideoModel implements VideoModel {
  async generate(input: Parameters<VideoModel["generate"]>[0]) {
    return {
      ok: true as const,
      data: {
        asset: {
          key: `mock/videos/${input.seed ?? "mock"}.mp4`,
          seconds: input.seconds,
        },
      },
    };
  }
}

// SPEC: Mock blob store. Persists bytes under BLOB_ROOT (real fs write so the
// "gen writes the blob" boundary is actually exercised), keyed by the asset key.
class MockBlobStore implements BlobStore {
  async putPrivate(input: Parameters<BlobStore["putPrivate"]>[0]) {
    const target = path.join(env.BLOB_ROOT, input.key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.body);
    return {
      ok: true as const,
      data: { key: input.key, size: input.body.byteLength },
    };
  }

  async signGetUrl(input: Parameters<BlobStore["signGetUrl"]>[0]) {
    return {
      ok: true as const,
      data: {
        url: `https://mock-blob.idream.local/${encodeURIComponent(input.key)}?ttl=${input.expiresInSeconds}`,
      },
    };
  }
}

function buildImageModel(): ImageModel {
  if (env.IMAGE_PROVIDER === "mock") return new MockImageModel();
  throw new Error(`Unsupported image provider: ${env.IMAGE_PROVIDER}`);
}

function buildVideoModel(): VideoModel {
  if (env.VIDEO_PROVIDER === "mock") return new MockVideoModel();
  throw new Error(`Unsupported video provider: ${env.VIDEO_PROVIDER}`);
}

export interface GenProviders {
  image: ImageModel;
  video: VideoModel;
  blob: BlobStore;
}

export const providers: GenProviders = {
  get image() {
    return buildImageModel();
  },
  get video() {
    return buildVideoModel();
  },
  blob: new MockBlobStore(),
};
