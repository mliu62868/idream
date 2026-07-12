import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(filePath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [filePath] : [];
  }));
  return nested.flat();
}

describe("Admin v2 architecture boundaries", () => {
  it("does not depend on the legacy admin service monolith", async () => {
    const roots = [
      path.join(process.cwd(), "src/server/modules/admin-v2"),
      path.join(process.cwd(), "src/app/api/v2/admin"),
    ];
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const offenders: string[] = [];
    const forbiddenImport = ["@/server/modules/admin", "service"].join("/");
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (source.includes(forbiddenImport)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
