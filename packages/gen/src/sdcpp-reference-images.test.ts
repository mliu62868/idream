import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupSdcppReferenceImages,
  materializeSdcppReferenceImages,
  parseSdcppReferenceImages,
  sdcppReferenceArgs,
} from "./sdcpp-reference-images";

describe("sdcpp reference images", () => {
  it("parses OpenAI-compatible reference_images payloads", () => {
    const references = parseSdcppReferenceImages(
      [
        {
          asset_id: "anchor-1",
          role: "identity_anchor",
          b64_json: Buffer.from("anchor").toString("base64"),
          weight: 1.25,
          content_type: "image/png",
        },
        {
          assetId: "source-1",
          role: "source_image",
          url: "https://blob.test/source.webp",
          weight: 0.7,
          contentType: "image/webp",
        },
        { role: "identity_reference" },
      ],
      2,
    );

    expect(references).toEqual([
      {
        assetId: "anchor-1",
        role: "identity_anchor",
        b64Json: Buffer.from("anchor").toString("base64"),
        weight: 1.25,
        contentType: "image/png",
      },
      {
        assetId: "source-1",
        role: "source_image",
        url: "https://blob.test/source.webp",
        weight: 0.7,
        contentType: "image/webp",
      },
    ]);
  });

  it("materializes base64 references and builds sd-cli args", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "idream-sdcpp-ref-"));
    try {
      const images = await materializeSdcppReferenceImages({
        dir,
        images: [
          {
            assetId: "source-1",
            role: "source_image",
            b64Json: Buffer.from("source-image").toString("base64"),
            contentType: "image/png",
          },
          {
            assetId: "anchor-1",
            role: "identity_anchor",
            b64Json: Buffer.from("anchor-image").toString("base64"),
            contentType: "image/webp",
          },
        ],
      });

      expect(await readFile(images[0].path, "utf8")).toBe("source-image");
      expect(await readFile(images[1].path, "utf8")).toBe("anchor-image");
      expect(path.extname(images[0].path)).toBe(".png");
      expect(path.extname(images[1].path)).toBe(".webp");

      expect(sdcppReferenceArgs({ images, mode: "auto", strength: 0.62 })).toEqual([
        "--init-img",
        images[0].path,
        "--strength",
        "0.62",
        "--ref-image",
        images[1].path,
      ]);

      await cleanupSdcppReferenceImages(images);
      await expect(readFile(images[0].path)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses multiple identity refs as ref-image inputs", () => {
    const images = [
      { role: "identity_anchor" as const, path: "/tmp/anchor.png" },
      { role: "identity_reference" as const, path: "/tmp/ref.png" },
    ];

    expect(sdcppReferenceArgs({ images, mode: "auto", strength: 0.62 })).toEqual([
      "--ref-image",
      "/tmp/anchor.png",
      "--ref-image",
      "/tmp/ref.png",
      "--increase-ref-index",
    ]);
  });
});
