export const imageOrientations = ["1:1", "4:5", "3:4", "9:16", "16:9"] as const;

export type ImageOrientation = (typeof imageOrientations)[number];

type Dimensions = {
  width: number;
  height: number;
};

export function normalizeImageOrientation(
  value: string | null | undefined,
  fallback: ImageOrientation = "4:5",
): ImageOrientation {
  return imageOrientations.includes(value as ImageOrientation)
    ? (value as ImageOrientation)
    : fallback;
}

export function dimensionsForImageOrientation(input: {
  orientation: string;
  defaultWidth: number;
  defaultHeight: number;
}): Dimensions {
  const base = snapDimension(Math.min(input.defaultWidth, input.defaultHeight));
  const orientation = normalizeImageOrientation(input.orientation);
  switch (orientation) {
    case "16:9":
      return { width: snapDimension((base * 16) / 9), height: base };
    case "9:16":
      return { width: base, height: snapDimension((base * 16) / 9) };
    case "4:5":
      return { width: base, height: snapDimension((base * 5) / 4) };
    case "3:4":
      return { width: base, height: snapDimension((base * 4) / 3) };
    case "1:1":
      return { width: base, height: base };
  }
}

function snapDimension(value: number) {
  const snapped = Math.round(value / 64) * 64;
  return Math.max(64, snapped);
}
