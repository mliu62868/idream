const DIRECT_STATIC_MEDIA_PATTERN =
  /^\/images\/ourdream\/.+\.(?:avif|webp)$/i;

export function shouldBypassNextImageOptimizer(url: string): boolean {
  const pathname = url.split(/[?#]/, 1)[0] ?? "";
  return (
    pathname.startsWith("/api/v1/media/") ||
    pathname.startsWith("/user-content/") ||
    DIRECT_STATIC_MEDIA_PATTERN.test(pathname)
  );
}

/**
 * True for media served behind the viewer's own session (signed media route or
 * per-user blob path). Such URLs must not be handed to a share/download target
 * that another viewer could open.
 */
export function isPrivateMediaUrl(url: string): boolean {
  return url.startsWith("/api/v1/media/") || url.startsWith("/user-content/");
}

/**
 * The bundled demo portrait. It ships with the app, so seeing it back from an
 * API means the record has no real asset yet — not that the viewer owns it.
 */
export function isBuiltInMediaPlaceholderUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("/images/ourdream/card-sarah-mercer.webp") ||
    lower.includes("%2fimages%2fourdream%2fcard-sarah-mercer.webp")
  );
}

/**
 * SPEC: detects an image that decoded to a flat field of one colour.
 * INTENT: a provider that returns an all-black/all-white frame is a failed
 * generation, but it loads fine — only the pixels reveal it. Sampled at 16x16
 * because a uniform image stays uniform when downscaled.
 * NOTE: needs a DOM (canvas); returns false whenever the pixels cannot be read
 * (tainted canvas, no 2d context) so an unreadable image is never called blank.
 */
export function isBlankImagePreview(image: HTMLImageElement): boolean {
  const width = Math.min(16, image.naturalWidth);
  const height = Math.min(16, image.naturalHeight);
  if (width <= 0 || height <= 0) return false;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;

    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    let min = 255;
    let max = 0;
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index] ?? 0;
      const green = data[index + 1] ?? 0;
      const blue = data[index + 2] ?? 0;
      const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
      min = Math.min(min, luminance);
      max = Math.max(max, luminance);
    }

    const range = max - min;
    return range <= 1 || (range <= 4 && (min >= 250 || max <= 5));
  } catch {
    return false;
  }
}
