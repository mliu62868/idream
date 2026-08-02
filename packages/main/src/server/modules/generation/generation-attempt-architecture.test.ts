import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function productionTypescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) return productionTypescriptFiles(filePath);
    if (!/\.tsx?$/.test(entry.name) || /(?:\.test|\.integration\.test|\.e2e)\.tsx?$/.test(entry.name)) {
      return [];
    }
    return [filePath];
  }));
  return nested.flat();
}

describe("GenerationAttempt write authority boundary", () => {
  it("keeps production Attempt creation and upsert inside GenerationAttemptAuthority", async () => {
    const root = path.join(process.cwd(), "src");
    const authority = path.join(
      root,
      "server/modules/generation/generation-attempt-authority.ts",
    );
    const files = (await productionTypescriptFiles(root)).filter(
      (file) => file !== authority,
    );
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/generationAttempt\.(?:create|upsert)\s*\(/.test(source)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps generation queue enqueue behind the Outbox dispatcher", async () => {
    const dispatchBuilder = await readFile(
      path.join(process.cwd(), "src/server/modules/generation/attempt-dispatch.ts"),
      "utf8",
    );
    const authority = await readFile(
      path.join(
        process.cwd(),
        "src/server/modules/generation/generation-attempt-authority.ts",
      ),
      "utf8",
    );

    expect(dispatchBuilder).not.toContain("jobQueue.enqueue(");
    expect(dispatchBuilder).not.toContain("generationAttempt.create(");
    expect(dispatchBuilder).not.toContain("generationAttempt.upsert(");
    expect(authority.match(/jobQueue\.enqueue\(/g)).toHaveLength(1);
  });
});
