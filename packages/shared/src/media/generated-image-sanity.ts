import { inflateSync } from "node:zlib";

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type PngHeader = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaceMethod: number;
};

type PngPixels = {
  header: PngHeader;
  data: Buffer;
  channels: number;
};

export class GeneratedImageSanityError extends Error {
  readonly code = "asset_quality_failed";

  constructor(message: string) {
    super(message);
    this.name = "GeneratedImageSanityError";
  }
}

export function assertGeneratedImageSanity(image: Buffer, source: string) {
  const pixels = decodePngPixels(image);
  if (!pixels) return;

  const stats = rgbLuminanceStats(pixels);
  if (stats.pixelCount === 0) {
    throw new GeneratedImageSanityError(`Generated image is empty: ${source}`);
  }
  if (stats.range <= 1) {
    throw new GeneratedImageSanityError(
      `Generated image is degenerate: ${source} has near-uniform pixels ` +
        `(luminance range ${stats.range}, min ${stats.min}, max ${stats.max})`,
    );
  }
  if (stats.range <= 4 && (stats.min >= 250 || stats.max <= 5)) {
    throw new GeneratedImageSanityError(
      `Generated image is blank: ${source} is nearly all ${stats.min >= 250 ? "white" : "black"} ` +
        `(luminance range ${stats.range})`,
    );
  }
}

function decodePngPixels(image: Buffer): PngPixels | null {
  const signature = image.subarray(0, pngSignature.length);
  if (image.length < pngSignature.length || !signature.equals(pngSignature)) {
    return null;
  }

  let offset = pngSignature.length;
  let header: PngHeader | null = null;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset);
    const type = image.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > image.length) throw new Error("Generated PNG is truncated");

    const chunkData = image.subarray(dataStart, dataEnd);
    const expectedCrc = image.readUInt32BE(dataEnd);
    const actualCrc = pngCrc32(image.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) {
      throw new GeneratedImageSanityError(`Generated PNG has invalid ${type} checksum`);
    }

    if (type === "IHDR") {
      if (length !== 13) throw new Error("Generated PNG has invalid IHDR");
      header = {
        width: chunkData.readUInt32BE(0),
        height: chunkData.readUInt32BE(4),
        bitDepth: chunkData[8] ?? 0,
        colorType: chunkData[9] ?? 0,
        interlaceMethod: chunkData[12] ?? 0,
      };
    } else if (type === "IDAT") {
      idatChunks.push(chunkData);
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  if (!header) throw new Error("Generated PNG is missing IHDR");
  if (idatChunks.length === 0) throw new Error("Generated PNG is missing IDAT");
  if (header.bitDepth !== 8 || header.interlaceMethod !== 0) return null;

  const channels = pngChannels(header.colorType);
  if (!channels) return null;
  if (header.width <= 0 || header.height <= 0) {
    throw new Error("Generated PNG has invalid dimensions");
  }

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const rowBytes = header.width * channels;
  const expectedBytes = (rowBytes + 1) * header.height;
  if (inflated.length < expectedBytes) throw new Error("Generated PNG pixel data is truncated");

  const pixels = Buffer.alloc(rowBytes * header.height);
  const previous = Buffer.alloc(rowBytes);
  const current = Buffer.alloc(rowBytes);
  let sourceOffset = 0;

  for (let y = 0; y < header.height; y += 1) {
    const filter = inflated[sourceOffset] ?? -1;
    sourceOffset += 1;
    inflated.copy(current, 0, sourceOffset, sourceOffset + rowBytes);
    sourceOffset += rowBytes;
    unfilterScanline(current, previous, channels, filter);
    current.copy(pixels, y * rowBytes);
    current.copy(previous);
  }

  return { header, data: pixels, channels };
}

function pngChannels(colorType: number) {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return null;
  }
}

function unfilterScanline(current: Buffer, previous: Buffer, bytesPerPixel: number, filter: number) {
  for (let index = 0; index < current.length; index += 1) {
    const left = index >= bytesPerPixel ? current[index - bytesPerPixel] ?? 0 : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;

    switch (filter) {
      case 0:
        break;
      case 1:
        current[index] = ((current[index] ?? 0) + left) & 0xff;
        break;
      case 2:
        current[index] = ((current[index] ?? 0) + up) & 0xff;
        break;
      case 3:
        current[index] = ((current[index] ?? 0) + Math.floor((left + up) / 2)) & 0xff;
        break;
      case 4:
        current[index] = ((current[index] ?? 0) + paeth(left, up, upLeft)) & 0xff;
        break;
      default:
        throw new Error(`Generated PNG uses unsupported filter ${filter}`);
    }
  }
}

function paeth(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function rgbLuminanceStats(pixels: PngPixels) {
  let min = 255;
  let max = 0;
  let pixelCount = 0;
  const { data, channels } = pixels;

  for (let index = 0; index < data.length; index += channels) {
    const luminance = pixelLuminance(data, index, channels);
    min = Math.min(min, luminance);
    max = Math.max(max, luminance);
    pixelCount += 1;
  }

  return { min, max, range: max - min, pixelCount };
}

function pixelLuminance(data: Buffer, index: number, channels: number) {
  if (channels === 1 || channels === 2) return data[index] ?? 0;
  const red = data[index] ?? 0;
  const green = data[index + 1] ?? 0;
  const blue = data[index + 2] ?? 0;
  return Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
}

const crcTable = new Uint32Array(256).map((_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function pngCrc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
