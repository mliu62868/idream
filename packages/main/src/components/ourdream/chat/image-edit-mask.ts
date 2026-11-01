export type MaskPoint = { x: number; y: number };

export function imagePoint(client: MaskPoint, bounds: { left: number; top: number; width: number; height: number }, width: number, height: number): MaskPoint {
  return {
    x: Math.max(0, Math.min(width - 1, (client.x - bounds.left) * width / bounds.width)),
    y: Math.max(0, Math.min(height - 1, (client.y - bounds.top) * height / bounds.height)),
  };
}

/** Work in original pixels, so zooming never alters the confirmed region. */
export function paintMask(mask: Uint8Array, width: number, height: number, from: MaskPoint, to: MaskPoint, radius: number, value: 0 | 255): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, radius / 2)));
  for (let step = 0; step <= steps; step++) {
    const x = from.x + (to.x - from.x) * step / steps;
    const y = from.y + (to.y - from.y) * step / steps;
    for (let py = Math.max(0, Math.floor(y - radius)); py <= Math.min(height - 1, Math.ceil(y + radius)); py++) {
      for (let px = Math.max(0, Math.floor(x - radius)); px <= Math.min(width - 1, Math.ceil(x + radius)); px++) {
        if ((px - x) ** 2 + (py - y) ** 2 <= radius ** 2) mask[py * width + px] = value;
      }
    }
  }
}

/** Connected color selection is a user gesture, never an object-segmentation claim. */
export function selectConnectedColor(mask: Uint8Array, pixels: Uint8Array, width: number, height: number, point: MaskPoint, tolerance: number): void {
  const start = Math.floor(point.y) * width + Math.floor(point.x);
  const seed = start * 4;
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  queue[0] = start; visited[start] = 1;
  let read = 0; let write = 1;
  while (read < write) {
    const index = queue[read++]!;
    const offset = index * 4;
    const distance = Math.max(...[0, 1, 2].map(channel => Math.abs(pixels[offset + channel]! - pixels[seed + channel]!)));
    if (pixels[offset + 3] !== pixels[seed + 3] || distance > tolerance) continue;
    mask[index] = 255;
    const x = index % width; const y = Math.floor(index / width);
    for (const next of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) {
      if (next >= 0 && !visited[next]) { visited[next] = 1; queue[write++] = next; }
    }
  }
}

export function maskFromRgba(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array<ArrayBuffer> {
  if (pixels.length !== width * height * 4) throw new Error("The saved selection has different dimensions.");
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index++) {
    const offset = index * 4; const value = pixels[offset]!;
    if ((value !== 0 && value !== 255) || pixels[offset + 1] !== value || pixels[offset + 2] !== value || pixels[offset + 3] !== 255) {
      throw new Error("The saved selection is invalid. Select the area again.");
    }
    mask[index] = value;
  }
  return mask;
}

export function maskRgba(mask: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const pixels = new Uint8ClampedArray(mask.length * 4);
  for (let index = 0; index < mask.length; index++) {
    pixels[index * 4] = mask[index]!; pixels[index * 4 + 1] = mask[index]!;
    pixels[index * 4 + 2] = mask[index]!; pixels[index * 4 + 3] = 255;
  }
  return pixels;
}
