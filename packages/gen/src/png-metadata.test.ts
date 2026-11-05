import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { assertGeneratedImageSanity } from "@idream/shared/media/generated-image-sanity";
import { stripPngMetadata } from "./png-metadata";

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(8, 0);
ihdr.writeUInt32BE(8, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const rows = Buffer.concat(Array.from({ length: 8 }, (_, y) => Buffer.concat([
  Buffer.from([0]),
  ...Array.from({ length: 8 }, (_unused, x) => Buffer.from([(x * 67 + y * 19) % 256, (x * 29 + y * 83) % 256, (x * 11 + y * 47) % 256])),
])));
const parts = {
  header: chunk("IHDR", ihdr),
  colorProfile: chunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f])),
  pixels: chunk("IDAT", deflateSync(rows)),
  end: chunk("IEND", Buffer.alloc(0)),
};
const clean = Buffer.concat([signature, parts.header, parts.colorProfile, parts.pixels, parts.end]);

describe("stripPngMetadata", () => {
  it("removes every text and provenance chunk and keeps everything else byte-identical", () => {
    const leaked = Buffer.concat([
      signature, parts.header,
      chunk("tEXt", Buffer.from("prompt\0secret", "latin1")),
      parts.colorProfile,
      chunk("zTXt", Buffer.from("workflow\0\0x", "latin1")),
      chunk("iTXt", Buffer.from("note\0\0\0\0\0x", "latin1")),
      chunk("eXIf", Buffer.from("II*\0", "latin1")),
      chunk("tIME", Buffer.alloc(7)),
      parts.pixels, parts.end,
    ]);
    const stripped = stripPngMetadata(new Uint8Array(leaked));
    expect(Buffer.from(stripped).equals(clean)).toBe(true);
    expect(() => assertGeneratedImageSanity(Buffer.from(stripped), "stripped")).not.toThrow();
  });

  it("returns the same bytes when there is nothing to remove", () => {
    const input = new Uint8Array(clean);
    expect(stripPngMetadata(input)).toBe(input);
  });

  it("leaves other formats and unwalkable files untouched", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(stripPngMetadata(jpeg)).toBe(jpeg);
    // A metadata chunk is present in both, so returning the input proves no rewrite happened.
    const overrunning = new Uint8Array(Buffer.concat([signature, chunk("tEXt", Buffer.from("a\0b", "latin1")), Buffer.from([0xff, 0xff, 0xff, 0xff, 0x74, 0x45, 0x58, 0x74, 0, 0, 0, 0])]));
    expect(stripPngMetadata(overrunning)).toBe(overrunning);
    const missingEnd = new Uint8Array(Buffer.concat([signature, parts.header, chunk("tEXt", Buffer.from("a\0b", "latin1")), parts.pixels]));
    expect(stripPngMetadata(missingEnd)).toBe(missingEnd);
  });

  it("works on a view into a larger buffer", () => {
    const padded = Buffer.concat([Buffer.alloc(16), signature, parts.header, chunk("tEXt", Buffer.from("a\0b", "latin1")), parts.pixels, parts.end]);
    const stripped = stripPngMetadata(new Uint8Array(padded.buffer, padded.byteOffset + 16, padded.byteLength - 16));
    expect(Buffer.from(stripped).includes("tEXt")).toBe(false);
    expect(Buffer.from(stripped).includes("IDAT")).toBe(true);
  });
});
