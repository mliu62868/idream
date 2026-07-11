const imageOrientationDefinitions = [
  { value: "1:1", ratio: 1 },
  { value: "4:5", ratio: 4 / 5 },
  { value: "3:4", ratio: 3 / 4 },
  { value: "9:16", ratio: 9 / 16 },
  { value: "16:9", ratio: 16 / 9 },
] as const;

export type ImageOrientation = (typeof imageOrientationDefinitions)[number]["value"];

export const imageOrientations = imageOrientationDefinitions.map(
  (definition) => definition.value,
) as [ImageOrientation, ...ImageOrientation[]];

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
  const ratio = imageOrientationDefinitions.find(
    (definition) => definition.value === orientation,
  )?.ratio ?? 1;
  return ratio >= 1
    ? { width: snapDimension(base * ratio), height: base }
    : { width: base, height: snapDimension(base / ratio) };
}

export function imageOrientationForDimensions(
  width: number | null,
  height: number | null,
  tolerance = 0.03,
): ImageOrientation | null {
  if (!width || !height) return null;
  const ratio = width / height;
  const closest = imageOrientationDefinitions.reduce((best, item) =>
    Math.abs(item.ratio - ratio) < Math.abs(best.ratio - ratio) ? item : best,
  );
  return Math.abs(closest.ratio - ratio) <= tolerance ? closest.value : null;
}

function snapDimension(value: number) {
  const snapped = Math.round(value / 64) * 64;
  return Math.max(64, snapped);
}
