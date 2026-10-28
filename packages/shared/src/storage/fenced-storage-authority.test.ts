import { describe, expect, it } from "vitest";
import { S3CompatibleBlobStore } from "./s3-blob";

function authority(endpoint: string, bucket = "test-bucket", secret = "test-secret", region = "us-east-1") {
  return new S3CompatibleBlobStore({ endpoint, bucket, region, accessKeyId: "test-access", secretAccessKey: secret }).getFencedStorageAuthority();
}

describe("fenced storage authority fingerprint", () => {
  it("binds the provider endpoint, bucket and region without credential material", () => {
    const original = authority("https://s3.example.test/base", "bucket-a");
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(authority("https://s3.example.test/base", "bucket-a", "different-secret")).toBe(original);
    expect(authority("https://other.example.test/base", "bucket-a")).not.toBe(original);
    expect(authority("https://s3.example.test/base", "bucket-b")).not.toBe(original);
    expect(authority("https://s3.example.test/base", "bucket-a", "test-secret", "eu-west-1")).not.toBe(original);
  });
  it("ignores URL credentials and query material rather than persisting secrets", () => {
    expect(authority("https://alice:secret@s3.example.test/base?token=private#fragment"))
      .toBe(authority("https://s3.example.test/base"));
  });
  it("does not equate different provider contracts for the same endpoint", () => {
    const common = { endpoint: "https://s3.example.test", bucket: "bucket", accessKeyId: "test", secretAccessKey: "test" };
    expect(new S3CompatibleBlobStore({ ...common, provider: "r2" }).getFencedStorageAuthority())
      .not.toBe(new S3CompatibleBlobStore({ ...common, provider: "s3" }).getFencedStorageAuthority());
  });
});
