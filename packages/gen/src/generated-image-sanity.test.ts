import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { assertGeneratedImageSanity } from "./generated-image-sanity";

describe("generated image sanity", () => {
  it("rejects pure white PNG outputs", () => {
    const image = pngFromRgb(4, 4, () => [255, 255, 255]);

    expect(() => assertGeneratedImageSanity(image, "white-test")).toThrow(/degenerate|blank/);
  });

  it("rejects pure black PNG outputs", () => {
    const image = pngFromRgb(4, 4, () => [0, 0, 0]);

    expect(() => assertGeneratedImageSanity(image, "black-test")).toThrow(/degenerate|blank/);
  });

  it("accepts PNG outputs with real pixel variation", () => {
    const image = pngFromRgb(4, 4, (x, y) => [
      x * 48,
      y * 48,
      (x + y) * 24,
    ]);

    expect(() => assertGeneratedImageSanity(image, "varied-test")).not.toThrow();
  });

  it("rejects PNG outputs with invalid chunk checksums", () => {
    const image = pngFromRgb(4, 4, (x, y) => [
      x * 48,
      y * 48,
      (x + y) * 24,
    ]);
    image[image.length - 1] = (image[image.length - 1] ?? 0) ^ 0xff;

    expect(() => assertGeneratedImageSanity(image, "corrupt-test")).toThrow(
      /invalid .* checksum/,
    );
  });
});

function pngFromRgb(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y);
      const index = 1 + x * 3;
      row[index] = red;
      row[index + 1] = green;
      row[index + 2] = blue;
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const chunk = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(chunk), 0);
  return Buffer.concat([length, chunk, crc]);
}

const crcTable = new Uint32Array(256).map((_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
