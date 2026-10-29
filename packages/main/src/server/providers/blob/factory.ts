import { S3CompatibleBlobStore } from "@idream/shared";
import { env } from "@/server/lib/env";
import type { BlobStore } from "../types";
import { MockBlobStore } from "./mock";

/** Construct storage independently of unrelated runtime provider credentials. */
export function createBlobStore(): BlobStore {
  if (env.BLOB_PROVIDER === "mock") {
    // Standalone materializers must retain the registry's production storage
    // requirement without requiring unrelated Chat or payment credentials.
    if (env.APP_ENV === "production") {
      throw new Error("Production requires non-mock providers: BLOB_PROVIDER");
    }
    return new MockBlobStore();
  }

  return new S3CompatibleBlobStore({
    endpoint: requireEnv("BLOB_ENDPOINT", env.BLOB_ENDPOINT),
    bucket: requireEnv("BLOB_BUCKET", env.BLOB_BUCKET),
    region: env.BLOB_REGION,
    provider: env.BLOB_PROVIDER,
    fencedWriteSemantics: env.BLOB_FENCED_IMPORT_SEMANTICS,
    accessKeyId: requireEnv(
      "BLOB_ACCESS_KEY_ID",
      env.BLOB_ACCESS_KEY_ID ?? env.BLOB_ACCESS_KEY ?? env.AWS_ACCESS_KEY_ID,
    ),
    secretAccessKey: requireEnv(
      "BLOB_SECRET_ACCESS_KEY",
      env.BLOB_SECRET_ACCESS_KEY ?? env.BLOB_SECRET_KEY ?? env.AWS_SECRET_ACCESS_KEY,
    ),
  });
}

function requireEnv(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required when BLOB_PROVIDER=${env.BLOB_PROVIDER}`);
  return value;
}
