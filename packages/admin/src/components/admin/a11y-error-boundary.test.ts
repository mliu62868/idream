import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(filePath);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [filePath] : [];
  }));
  return children.flat();
}

describe("Admin dynamic error accessibility boundary", () => {
  it("announces every direct error/err state through an alert role", async () => {
    const packageSource = path.resolve(import.meta.dirname, "../..");
    const files = await sourceFiles(packageSource);
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/\{(?:error|err)\s*\?\s*<(?:p|div)\b([^>]*)>/g)) {
        if (!/\brole=["']alert["']/.test(match[1] ?? "")) {
          const line = source.slice(0, match.index).split("\n").length;
          offenders.push(`${path.relative(packageSource, file)}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
