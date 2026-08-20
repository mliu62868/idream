import { chatFsPaths, readWhole } from "./chat-fs.js";

/** Boundaries remain Chat-owned and fail closed; they are not generic memory. */
export async function readBoundaries(userId: string): Promise<string[]> {
  const raw = await readWhole(chatFsPaths.boundaries(userId));
  if (!raw) return [];
  return raw.split("\n").flatMap((rawLine) => {
    const line = rawLine.trim();
    if (!/^[-*]\s+/u.test(line)) return [];
    const withoutComment = line.replace(/<!--([\s\S]*?)-->/u, "").trim();
    const text = withoutComment
      .replace(/^[-*]\s+/u, "")
      .replace(/^\[[a-z_]+\]\s*/iu, "")
      .trim();
    return text ? [text] : [];
  });
}
