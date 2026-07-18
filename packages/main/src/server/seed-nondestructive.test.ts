import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const seedPath = path.resolve(process.cwd(), "prisma/seed.ts");

describe("production seed authority boundaries", () => {
  it("does not rewrite operator-owned model profiles or seed application routes into CMS", async () => {
    const source = await readFile(seedPath, "utf8");

    expect(source).not.toContain("prisma.generationModelProfile.updateMany");
    expect(source).not.toContain("prisma.routePage.upsert");
    expect(source).toContain(
      'if (!existingProfileKeys.has("profile_image_default_v1"))',
    );
  });

  it("merges official provenance without replacing existing JSON fields", async () => {
    const source = await readFile(seedPath, "utf8");

    expect(source).toContain("...existingMetadata");
    expect(source).toContain("...existingAdvancedDetails");
    expect(source).toContain("...existingProvenance");
  });

  it("creates defaults only when no pricing history exists", async () => {
    const source = await readFile(seedPath, "utf8");

    expect(source).toContain("if (activeAuthorities.length > 1)");
    expect(source).toContain("if (activeAuthorities.length === 1) return;");
    expect(source).toContain("if (existingHistory)");
    expect(source).toContain("publish one explicitly");
    expect(source).toContain("await prisma.pricingRule.create");
  });

  it("does not reset live feature-flag rollout decisions on repeat runs", async () => {
    const source = await readFile(seedPath, "utf8");
    const updateBodies = Array.from(
      source.matchAll(
        /prisma\.featureFlag\.upsert\(\{[\s\S]*?update:\s*\{([^}]*)\}/g,
      ),
      (match) => match[1] ?? "",
    );

    expect(updateBodies.length).toBeGreaterThan(0);
    for (const updateBody of updateBodies) {
      expect(updateBody).not.toContain("enabled:");
      expect(updateBody).not.toContain("rolloutPercent:");
      expect(updateBody).not.toContain("hardPolicy:");
      expect(updateBody).not.toContain("targetRoles:");
      expect(updateBody).not.toContain("targetPlans:");
    }
  });
});
