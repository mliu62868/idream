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

  it("keeps legacy domain modules independent from the dispatcher monolith", async () => {
    const root = path.join(process.cwd(), "src/server/modules/admin");
    const dispatcher = path.join(root, "service.ts");
    const files = (await sourceFiles(root)).filter((file) => file !== dispatcher);
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

  it("keeps the legacy user domain implementation out of the dispatcher monolith", async () => {
    const dispatcher = await readFile(
      path.join(process.cwd(), "src/server/modules/admin/service.ts"),
      "utf8",
    );
    const userDomain = await readFile(
      path.join(process.cwd(), "src/server/modules/admin/users/service.ts"),
      "utf8",
    ).catch(() => "");

    expect(dispatcher).not.toContain("const statusChangeSchema");
    expect(dispatcher).not.toContain("async function listUsers");
    expect(dispatcher).not.toContain("async function setUserPermission");
    expect(userDomain).toContain("export async function listUsers");
    expect(userDomain).toContain("export async function setUserPermission");
    expect(userDomain).not.toContain(["@/server/modules/admin", "service"].join("/"));
  });

  it("keeps generation config and dead-letter authorities out of the dispatcher monolith", async () => {
    const dispatcher = await readFile(
      path.join(process.cwd(), "src/server/modules/admin/service.ts"),
      "utf8",
    );
    const configDomain = await readFile(
      path.join(process.cwd(), "src/server/modules/admin/generation/config/service.ts"),
      "utf8",
    ).catch(() => "");
    const deadLetterDomain = await readFile(
      path.join(process.cwd(), "src/server/modules/admin/generation/dead-letter/service.ts"),
      "utf8",
    ).catch(() => "");

    expect(dispatcher).not.toContain("const modelProfileSchema");
    expect(dispatcher).not.toContain("async function listModelProfiles");
    expect(dispatcher).not.toContain("async function deadLetterQueue");
    expect(dispatcher).not.toContain("async function requeueDeadLetterBatch");
    expect(configDomain).toContain("export async function listModelProfiles");
    expect(deadLetterDomain).toContain("export async function deadLetterQueue");
    expect(configDomain).not.toContain(["@/server/modules/admin", "service"].join("/"));
    expect(deadLetterDomain).not.toContain(["@/server/modules/admin", "service"].join("/"));
  });
});
