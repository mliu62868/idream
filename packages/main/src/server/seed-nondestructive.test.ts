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
    expect(source).toContain(
      'if (!existingProfileKeys.has("character-image-single-identity-redcraft"))',
    );
    expect(source).toContain("fp8_resident_bf16_transient_mps");
    expect(source).not.toContain("Krea2RedMix3.0-bf16.safetensors");
  });

  it("merges official provenance without replacing existing JSON fields", async () => {
    const source = await readFile(seedPath, "utf8");

    expect(source).toContain("...existingMetadata");
    // Persona merge precedence is covered by official-cold-start-content.test;
    // this guard verifies the seed writes that authority's merged result.
    expect(source).toContain("resolveOfficialColdStartPersonaWrite({");
    expect(source).toContain("...personaWrite.advancedDetails");
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
