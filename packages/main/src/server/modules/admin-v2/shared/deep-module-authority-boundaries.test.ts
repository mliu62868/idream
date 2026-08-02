import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(path, "utf8");
}

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "test" ? [] : productionTypeScriptFiles(file);
    }
    return entry.isFile() && file.endsWith(".ts") && !file.endsWith(".test.ts")
      ? [file]
      : [];
  });
}

describe("deep module authority boundaries", () => {
  it("keeps image and video provider execution out of Main", () => {
    const pipeline = source("src/server/ai/local-pipeline.ts");
    const finalizer = source("src/processes/finalizer.ts");
    const providerProduction = productionTypeScriptFiles("src/server/providers")
      .map(source)
      .join("\n");

    expect(pipeline).not.toContain("providers.image.generate");
    expect(pipeline).not.toContain("providers.video.generate");
    expect(pipeline).not.toContain('job.queue === "ai.image.generate"');
    expect(pipeline).not.toContain('job.queue === "ai.video.generate"');
    expect(finalizer).not.toContain("localAiQueueNames");
    expect(providerProduction).not.toContain("IMAGE_PROVIDER");
    expect(providerProduction).not.toContain("MockImageModel");
    expect(providerProduction).not.toContain("PipelineImageModel");
    expect(providerProduction).not.toContain("MockVideoModel");
    expect(providerProduction).not.toMatch(/\b(image|video):\s*(create|new )/);
  });

  it("keeps DreamcoinLedger production writes inside the billing ledger owner", () => {
    const writers = productionTypeScriptFiles("src/server")
      .filter((file) => /dreamcoinLedger\.(create|upsert|update|delete)/.test(source(file)))
      .map((file) => path.relative(process.cwd(), file));

    expect(writers).toEqual(["src/server/modules/admin/billing/ledger.ts"]);
  });

  it("forbids cross-service Redis delivery and the optional HTTP cutover flag", () => {
    const roots = ["../shared/src", "src", "../chat/src"];
    const production = roots.flatMap(productionTypeScriptFiles).map(source).join("\n");

    expect(production).not.toContain("MAIN_TO_CHAT_QUEUE");
    expect(production).not.toContain("MAIN_QUEUES.mainInbound");
    expect(production).not.toContain('"chat.inbound"');
    expect(production).not.toContain('"main.inbound"');
    expect(production).not.toContain("CHAT_DURABLE_INGEST_URL");
  });

  it("keeps Character Journey derivation on the server", () => {
    const adminCharacterUi = source("../admin/src/features/characters/CharacterWorkspace.tsx");
    const portfolio = source("src/server/modules/admin-v2/characters/portfolio.ts");
    const workspace = source("src/server/modules/admin-v2/characters/workspace.ts");

    expect(adminCharacterUi).not.toContain("resolveCharacterProductionEntry");
    expect(adminCharacterUi).not.toContain(".nextAction");
    expect(portfolio).toContain("projectCharacterProductionJourneys");
    expect(portfolio).toContain("journey,");
    expect(workspace).toContain("journey: portfolioItem.journey");
  });
});
