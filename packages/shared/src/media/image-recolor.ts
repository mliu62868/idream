/** The same pixel operation drives the browser preview and Gen's final output. */
export const IMAGE_RECOLOR_ALGORITHM = "hsl-lightness-preserving-1" as const;

/**
 * Change hue and saturation only inside a binary, user-confirmed region.
 * Original HSL lightness and alpha stay fixed: no diffusion, resampling, blur,
 * neighborhood synthesis or change to the shape of the selected object.
 */
export function recolorRgba(input: {
  pixels: Uint8Array;
  mask: Uint8Array;
  color: string;
}): Uint8Array {
  if (!input.pixels.length || input.pixels.length !== input.mask.length * 4 ||
    input.mask.some(value => value !== 0 && value !== 255) || !/^#[0-9a-f]{6}$/i.test(input.color)) {
    throw new Error("Recolor requires RGBA pixels, an equally sized binary mask and a six-digit color");
  }
  const color = [1, 3, 5].map(index => Number.parseInt(input.color.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = color;
  const maximum = Math.max(red!, green!, blue!);
  const minimum = Math.min(red!, green!, blue!);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta !== 0) {
    if (maximum === red) hue = ((green! - blue!) / delta + 6) % 6;
    else if (maximum === green) hue = (blue! - red!) / delta + 2;
    else hue = (red! - green!) / delta + 4;
  }
  const secondary = 1 - Math.abs(hue % 2 - 1);
  const direction = hue < 1 ? [1, secondary, 0]
    : hue < 2 ? [secondary, 1, 0]
    : hue < 3 ? [0, 1, secondary]
    : hue < 4 ? [0, secondary, 1]
    : hue < 5 ? [secondary, 0, 1] : [1, 0, secondary];
  // Buffer.slice aliases its input, unlike Uint8Array.slice. Gen must retain
  // untouched source bytes for the independent preservation comparison.
  const output = new Uint8Array(input.pixels);
  for (let pixel = 0; pixel < input.mask.length; pixel++) {
    if (input.mask[pixel] === 0) continue;
    const offset = pixel * 4;
    const sourceLightness = (Math.max(input.pixels[offset]!, input.pixels[offset + 1]!, input.pixels[offset + 2]!) +
      Math.min(input.pixels[offset]!, input.pixels[offset + 1]!, input.pixels[offset + 2]!)) / 510;
    const chroma = (1 - Math.abs(2 * sourceLightness - 1)) * saturation;
    const floor = sourceLightness - chroma / 2;
    for (let channel = 0; channel < 3; channel++) {
      output[offset + channel] = Math.round((direction[channel]! * chroma + floor) * 255);
    }
  }
  return output;
}
