import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const workspaceRoot = path.resolve(packageRoot, "../..");

describe("admin source boundary", () => {
  it("resolves application source from the admin package only", async () => {
    const tsconfig = await readFile(path.join(packageRoot, "tsconfig.json"), "utf8");
    const globals = await readFile(path.join(packageRoot, "src/app/globals.css"), "utf8");
    const nextConfig = await readFile(path.join(packageRoot, "next.config.ts"), "utf8");
    const turboConfig = await readFile(path.join(workspaceRoot, "turbo.json"), "utf8");

    expect(tsconfig).not.toContain("../main/src");
    expect(globals).not.toContain("main/src");
    expect(nextConfig).not.toContain("../main/src");
    expect(nextConfig).not.toContain("reuses TS source from packages/main");
    expect(turboConfig).not.toContain("../main/src");
    expect(turboConfig).not.toContain("../main/prisma");
    const legacyMainUi = await readdir(path.join(workspaceRoot, "packages/main/src/components/admin"), { recursive: true })
      .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    expect(legacyMainUi.filter((entry) => /\.[cm]?[jt]sx?$/.test(entry))).toEqual([]);
  });
});
