import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hydratedImageReferenceInputs } from "./image-references";

describe("source snapshot hydration", () => {
  it("passes precisely the verified stored bytes to the provider, never the original URL", async () => {
    const bytes = Buffer.from("accepted source image");
    const getPrivate = vi.fn().mockResolvedValue({ ok: true, data: { body: bytes, contentType: "image/png" } });
    const signGetUrl = vi.fn();
    const [result] = await hydratedImageReferenceInputs([{
      assetId: "source", role: "source_image", storageKey: "snapshot/source",
      url: "https://example.test/changed", contentSha256: createHash("sha256").update(bytes).digest("hex"),
    }], { getPrivate, signGetUrl });
    expect(result?.b64Json).toBe(bytes.toString("base64"));
    expect(result?.url).toBeUndefined();
    expect(signGetUrl).not.toHaveBeenCalled();
    expect(getPrivate).toHaveBeenCalledOnce();
  });

  it("fails closed if the snapshot is missing, replaced, or cannot be read", async () => {
    const image = { assetId: "source", role: "source_image" as const, storageKey: "snapshot/source", contentSha256: "a".repeat(64) };
    const signGetUrl = vi.fn();
    await expect(hydratedImageReferenceInputs([image], { signGetUrl })).rejects.toThrow(/cannot be read/);
    await expect(hydratedImageReferenceInputs([image], { signGetUrl, getPrivate: async () => ({ ok: false, error: "missing" }) })).rejects.toThrow(/integrity/);
    await expect(hydratedImageReferenceInputs([image], { signGetUrl, getPrivate: async () => ({ ok: true, data: { body: Buffer.from("replaced"), contentType: null } }) })).rejects.toThrow(/integrity/);
    expect(signGetUrl).not.toHaveBeenCalled();
  });

  it("verifies the frozen Main snapshot before exposing bytes to the model", async () => {
    const bytes = Buffer.from("frozen source");
    const image = { assetId: "source", role: "source_image" as const, sourceSnapshotId: "snapshot", contentSha256: createHash("sha256").update(bytes).digest("hex") };
    const [reference] = await hydratedImageReferenceInputs([image], { signGetUrl: vi.fn(), getSourceSnapshot: async () => bytes });
    expect(Buffer.from(reference!.b64Json!, "base64")).toEqual(bytes);
    await expect(hydratedImageReferenceInputs([image], { signGetUrl: vi.fn(), getSourceSnapshot: async () => Buffer.from("replaced") })).rejects.toThrow(/integrity/);
  });
});
