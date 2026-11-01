import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { CONFIRMED_IMAGE_EDIT_VERSION, LOCAL_IMAGE_EDIT_VERSION, LOCAL_IMAGE_EDIT_MODEL_SHA256 } from "@idream/shared/chat/image-action";
import { compositeLocalizedImageEdit, prepareLocalizedImageEdit, type SegmentImage } from "./localized-image-edit";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pin = { mode: "local", target: "scarf", selection: "one", version: LOCAL_IMAGE_EDIT_VERSION, modelSha256: LOCAL_IMAGE_EDIT_MODEL_SHA256 } as const;
async function fixture() {
  const source = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#218954" } }).png().toBuffer();
  const maskPixels = Buffer.alloc(4096);
  for (let y = 18; y < 32; y += 1) for (let x = 22; x < 42; x += 1) maskPixels[y * 64 + x] = 255;
  const mask = await sharp(maskPixels, { raw: { width: 64, height: 64, channels: 1 } }).png().toBuffer();
  const segment: SegmentImage = async ({ source: canonical, pin: accepted }) => ({ mask, evidence: {
    status: "ok", sourceSha256: hash(canonical), modelSha256: accepted.modelSha256, maskSha256: hash(mask),
    width: 64, height: 64, target: accepted.target, selection: accepted.selection,
    maskPixels: 280, totalPixels: 4096, candidates: [{ score: 0.9, presence: 0.95 }], elapsedMs: 5,
  } });
  const input = { count: 1, controls: { localizedEdit: pin, orientation: "original", width: 64, height: 64, sourceImageAssetId: "source" },
    referenceImages: [{ assetId: "source", role: "source_image" as const, sourceSnapshotId: "snapshot", contentSha256: hash(source), b64Json: source.toString("base64") }] };
  return { input, source, maskPixels, segment };
}

async function confirmedFixture() {
  const legacy = await fixture();
  const source = await sharp(legacy.source).ensureAlpha().png().toBuffer();
  const mask = await sharp(legacy.maskPixels, { raw: { width: 64, height: 64, channels: 1 } }).toColourspace("b-w").png().toBuffer();
  const confirmed = { mode: "local", target: "scarf", selection: "one", version: CONFIRMED_IMAGE_EDIT_VERSION,
    sourceSnapshotId: "snapshot", sourceSha256: hash(source), width: 64, height: 64,
    maskPngBase64: mask.toString("base64"), maskSha256: hash(mask), confirmationId: "confirmation",
    confirmedAt: "2026-10-31T01:00:00.000Z", operation: { kind: "recolor", color: "#ff0000" } } as const;
  return { ...legacy, source, mask, confirmed, input: { ...legacy.input, controls: { ...legacy.input.controls, localizedEdit: confirmed },
    referenceImages: [{ ...legacy.input.referenceImages[0]!, b64Json: source.toString("base64"), contentSha256: hash(source) }] } };
}

function animatedPng(frame: Buffer) {
  const chunk = (name: string, data: Buffer) => {
    const bytes = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    const header = Buffer.alloc(4), checksum = Buffer.alloc(4);
    header.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, bytes, checksum]);
  };
  const ihdr = frame.subarray(8, 33);
  const imageChunks: Buffer[] = [];
  for (let offset = 33; offset + 12 <= frame.length;) {
    const length = frame.readUInt32BE(offset);
    if (frame.toString("ascii", offset + 4, offset + 8) === "IDAT") imageChunks.push(frame.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const control = Buffer.alloc(8); control.writeUInt32BE(2);
  const frameControl = (sequence: number) => {
    const data = Buffer.alloc(26); data.writeUInt32BE(sequence); data.writeUInt32BE(frame.readUInt32BE(16), 4); data.writeUInt32BE(frame.readUInt32BE(20), 8);
    data.writeUInt16BE(1, 20); data.writeUInt16BE(10, 22); return data;
  };
  const sequence = Buffer.alloc(4); sequence.writeUInt32BE(2);
  const compressed = Buffer.concat(imageChunks);
  return Buffer.concat([frame.subarray(0, 8), ihdr, chunk("acTL", control), chunk("fcTL", frameControl(0)), chunk("IDAT", compressed),
    chunk("fcTL", frameControl(1)), chunk("fdAT", Buffer.concat([sequence, compressed])), chunk("IEND", Buffer.alloc(0))]);
}

describe("localized image preservation", () => {
  it("uses the exact user-confirmed mask without invoking SAM", async () => {
    const { input, mask } = await confirmedFixture();
    const segment = vi.fn<SegmentImage>();
    const prepared = (await prepareLocalizedImageEdit(input, segment))!;
    expect(segment).not.toHaveBeenCalled();
    expect(prepared.maskBody).toEqual(mask);
    expect(prepared.operation).toEqual({ kind: "recolor", color: "#ff0000" });
    expect(prepared.evidence).toMatchObject({ version: CONFIRMED_IMAGE_EDIT_VERSION, confirmationId: "confirmation",
      sourceSnapshotId: "snapshot", regionAuthority: "user_confirmation", maskPixels: 280 });
  });

  it.each(["sourceHash", "snapshot", "maskHash", "geometry", "soft", "alpha", "rgb", "empty"])("rejects invalid confirmed %s before SAM", async kind => {
    const { input, mask } = await confirmedFixture();
    const confirmed: Record<string, unknown> = { ...input.controls.localizedEdit };
    if (kind === "sourceHash") confirmed.sourceSha256 = "f".repeat(64);
    if (kind === "snapshot") confirmed.sourceSnapshotId = "other";
    if (kind === "maskHash") confirmed.maskSha256 = "f".repeat(64);
    if (kind === "geometry") confirmed.width = 63;
    if (["soft", "alpha", "rgb", "empty"].includes(kind)) {
      const invalid = kind === "alpha" ? await sharp(mask).ensureAlpha().png().toBuffer()
        : kind === "rgb" ? await sharp(mask).toColourspace("srgb").png().toBuffer()
          : await sharp({ create: { width: 64, height: 64, channels: 3, background: kind === "soft" ? "#777777" : "black" } }).toColourspace("b-w").png().toBuffer();
      confirmed.maskPngBase64 = invalid.toString("base64"); confirmed.maskSha256 = hash(invalid);
    }
    const segment = vi.fn<SegmentImage>();
    await expect(prepareLocalizedImageEdit({ ...input, controls: { ...input.controls, localizedEdit: confirmed } }, segment)).rejects.toThrow();
    expect(segment).not.toHaveBeenCalled();
  });

  it("accepts an explicitly confirmed whole-frame mask without the historical SAM area heuristic", async () => {
    const { input } = await confirmedFixture();
    const mask = await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } }).toColourspace("b-w").png().toBuffer();
    const prepared = await prepareLocalizedImageEdit({ ...input, controls: { ...input.controls,
      localizedEdit: { ...input.controls.localizedEdit, maskPngBase64: mask.toString("base64"), maskSha256: hash(mask) } } }, vi.fn<SegmentImage>());
    expect(prepared?.evidence.maskPixels).toBe(4096);
  });

  it.each(["noncanonicalBase64", "rgbSource"])("rejects confirmed %s instead of silently changing the frozen decoding contract", async kind => {
    const { input, source } = await confirmedFixture();
    if (kind === "noncanonicalBase64") input.referenceImages[0]!.b64Json += "\n";
    else {
      const rgb = await sharp(source).removeAlpha().png().toBuffer();
      input.referenceImages[0]!.b64Json = rgb.toString("base64");
      input.referenceImages[0]!.contentSha256 = hash(rgb);
      input.controls.localizedEdit = { ...input.controls.localizedEdit, sourceSha256: hash(rgb) };
    }
    await expect(prepareLocalizedImageEdit(input, vi.fn<SegmentImage>())).rejects.toThrow();
  });

  it.each(["mask", "source"])("rejects a confirmed animated PNG %s even when the PNG decoder only exposes its first frame", async kind => {
    const { input, source, mask } = await confirmedFixture();
    const animated = animatedPng(kind === "mask" ? mask : source);
    if (kind === "mask") input.controls.localizedEdit = { ...input.controls.localizedEdit, maskPngBase64: animated.toString("base64"), maskSha256: hash(animated) };
    else {
      input.referenceImages[0]!.b64Json = animated.toString("base64");
      input.referenceImages[0]!.contentSha256 = hash(animated);
      input.controls.localizedEdit = { ...input.controls.localizedEdit, sourceSha256: hash(animated) };
    }
    const accepted = await prepareLocalizedImageEdit(input, vi.fn<SegmentImage>()).then(() => true, () => false);
    expect(accepted).toBe(false);
  });

  it("repairs every non-target pixel even when the generator redraws the entire frame", async () => {
    const { input, source, maskPixels, segment } = await fixture();
    const prepared = (await prepareLocalizedImageEdit(input, segment))!;
    const candidate = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#dc2323" } }).png().toBuffer();
    const result = await compositeLocalizedImageEdit(prepared, candidate);
    const [original, generated, actual] = await Promise.all([source, candidate, result.body].map(bytes => sharp(bytes).ensureAlpha().raw().toBuffer()));
    for (let pixel = 0; pixel < 4096; pixel += 1) {
      const expected = maskPixels[pixel] ? generated! : original!;
      expect(actual!.subarray(pixel * 4, pixel * 4 + 4)).toEqual(expected.subarray(pixel * 4, pixel * 4 + 4));
    }
    expect(result.preservation.evidence).toMatchObject({ changedProtectedPixels: 0, changedTargetPixels: 280, protectedPixels: 3816, intentVerified: false, frozenSourceSha256: hash(source), resultSha256: hash(result.body) });
  });

  it("preserves source transparency outside the mask", async () => {
    const { input, maskPixels, segment } = await fixture();
    const source = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 32, g: 130, b: 68, alpha: 0.25 } } }).png().toBuffer();
    input.referenceImages[0]!.b64Json = source.toString("base64");
    input.referenceImages[0]!.contentSha256 = hash(source);
    const prepared = (await prepareLocalizedImageEdit(input, segment))!;
    const candidate = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } }).png().toBuffer();
    const result = await compositeLocalizedImageEdit(prepared, candidate);
    const actual = await sharp(result.body).raw().toBuffer();
    const original = await sharp(source).raw().toBuffer();
    expect((await sharp(result.body).metadata()).hasAlpha).toBe(true);
    for (let p = 0; p < maskPixels.length; p += 1) if (!maskPixels[p]) expect(actual.subarray(p * 4, p * 4 + 4)).toEqual(original.subarray(p * 4, p * 4 + 4));
  });

  it("rejects a changed source before invoking segmentation", async () => {
    const { input, segment } = await fixture();
    let invoked = false;
    input.referenceImages[0]!.contentSha256 = "0".repeat(64);
    await expect(prepareLocalizedImageEdit(input, async value => { invoked = true; return segment(value); })).rejects.toThrow("source hash");
    expect(invoked).toBe(false);
  });

  it.each(["hash", "geometry", "all", "empty", "soft"])("rejects %s mask evidence instead of falling back to full-image rendering", async kind => {
    const { input, segment } = await fixture();
    await expect(prepareLocalizedImageEdit(input, async value => {
      const result = await segment(value);
      const evidence = result.evidence as Record<string, unknown>;
      if (kind === "hash") evidence.maskSha256 = "f".repeat(64);
      else if (kind === "geometry") evidence.width = 63;
      else {
        result.mask = await sharp({ create: { width: 64, height: 64, channels: 3, background: kind === "all" ? "white" : kind === "empty" ? "black" : "#777777" } }).greyscale().png().toBuffer();
        evidence.maskSha256 = hash(result.mask);
        evidence.maskPixels = kind === "empty" ? 0 : 4096;
      }
      return result;
    })).rejects.toThrow();
  });

  it("does not deliver a no-op or resized candidate", async () => {
    const { input, source, segment } = await fixture();
    const prepared = (await prepareLocalizedImageEdit(input, segment))!;
    await expect(compositeLocalizedImageEdit(prepared, source)).rejects.toThrow("no target change");
    await expect(compositeLocalizedImageEdit(prepared, await sharp(source).resize(128, 64).png().toBuffer())).rejects.toThrow("dimensions changed");
  });
});
