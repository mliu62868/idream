import { deflateSync } from "node:zlib";
import type { ImageModel } from "../types";

export class MockImageModel implements ImageModel {
  async generate(input: Parameters<ImageModel["generate"]>[0]) {
    const count = Math.max(1, Math.min(input.count, 4));
    const seed = input.seed ?? "mock";

    return {
      ok: true as const,
      data: {
        assets: Array.from({ length: count }, (_, index) => ({
          key: `mock/images/${seed}-${index + 1}.png`,
          width: mockImageWidth,
          height: mockImageHeight,
          body: mockPortraitPng(`${seed}:${index + 1}`),
          contentType: "image/png",
        })),
      },
    };
  }
}

const mockImageWidth = 256;
const mockImageHeight = 320;

function mockPortraitPng(seed: string) {
  const accent = hashString(seed) % 96;
  const rows: Buffer[] = [];
  for (let y = 0; y < mockImageHeight; y += 1) {
    const row = Buffer.alloc(1 + mockImageWidth * 3);
    row[0] = 0;
    for (let x = 0; x < mockImageWidth; x += 1) {
      const pixel = mockPortraitPixel(x, y, accent);
      const offset = 1 + x * 3;
      row[offset] = pixel[0];
      row[offset + 1] = pixel[1];
      row[offset + 2] = pixel[2];
    }
    rows.push(row);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(mockImageWidth, 0);
  header.writeUInt32BE(mockImageHeight, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function mockPortraitPixel(x: number, y: number, accent: number): [number, number, number] {
  const horizontal = x / mockImageWidth;
  const vertical = y / mockImageHeight;
  const glow = Math.max(0, 1 - Math.hypot((x - 128) / 150, (y - 130) / 190));
  const background: [number, number, number] = [
    Math.round(19 + accent * 0.2 + glow * 28),
    Math.round(13 + glow * 16),
    Math.round(31 + accent * 0.35 + glow * 45),
  ];

  const head = ((x - 128) / 47) ** 2 + ((y - 105) / 58) ** 2 <= 1;
  const shoulders = ((x - 128) / 103) ** 2 + ((y - 260) / 112) ** 2 <= 1 && y >= 169;
  if (head || shoulders) {
    const shade = Math.round(150 + glow * 55 - vertical * 24 + horizontal * 8);
    return [
      Math.min(245, shade + 24),
      Math.min(235, shade + 4),
      Math.min(255, shade + 38),
    ];
  }
  return background;
}

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const content = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(content), 0);
  return Buffer.concat([length, content, checksum]);
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

function hashString(value: string) {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}
