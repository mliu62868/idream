import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileCharacterSoul } from "@idream/shared";
import { characterSoulBehaviorCaseKeys } from "@idream/shared/admin";
import {
  executeCharacterSoulQaEvidence,
  requiredCharacterSoulChatProfiles,
} from "./soul-evaluation";

function soul(name: string, tone: string) {
  const compiled = compileCharacterSoul({
    name,
    age: 29,
    gender: "female",
    relationshipArchetype: "companion",
    characterPromise: `${name} offers a specific point of view.`,
    personality: "Observant and candid",
    tone,
    cadence: "Measured sentences",
    vocabulary: [name.toLowerCase()],
    voiceHabits: ["asks one precise question"],
    voiceAvoid: ["generic assistant language"],
    backstory: `${name} has an established adult history.`,
    values: ["honesty"],
    wants: ["connection"],
    fears: ["being misunderstood"],
    contradictions: ["bold but careful"],
    interaction: {
      initiative: "balanced",
      curiosity: "specific",
      pacing: "steady",
      affection: "earned",
      conflict: "direct",
      repair: "explicit",
    },
    canon: { facts: [`${name} is an adult.`], unknowns: ["Unstated facts stay unknown."] },
    dialogue: {
      positive: [{
        context: "opening",
        user: "Hello",
        assistant: `I'm ${name}. Tell me what matters.`,
        demonstrates: ["specific"],
      }],
      negative: [{ assistant: "How may I assist?", reason: "generic" }],
    },
  });
  if (!compiled.ok) throw new Error("test Soul did not compile");
  return compiled.snapshot;
}

afterEach(() => vi.unstubAllEnvs());

describe("server-executed Character Soul QA", () => {
  it("uses the local Chat runtime file without mutating Main's environment", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "character-soul-chat-env-"));
    const runtimeFile = path.join(directory, ".env");
    writeFileSync(runtimeFile, [
      "CHAT_MODEL_PROVIDER=openai",
      "CHAT_MODEL_BASE_URL=http://127.0.0.1:9999/v1",
      "CHAT_MODEL_NAME=exact-chat-runtime-model",
      "CHAT_MODEL_API_KEY=test-key",
    ].join("\n"));
    try {
      const source = {
        APP_ENV: "development",
        NODE_ENV: "development",
        CHAT_RUNTIME_ENV_FILE: runtimeFile,
        CHAT_MODEL_PROVIDER: "mock",
      };
      const profiles = requiredCharacterSoulChatProfiles(source);

      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.profile).toMatchObject({
        provider: "openai",
        model: "exact-chat-runtime-model",
        baseUrl: "http://127.0.0.1:9999/v1",
      });
      expect(source.CHAT_MODEL_PROVIDER).toBe("mock");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not read a local Chat runtime file in production", () => {
    const profiles = requiredCharacterSoulChatProfiles({
      APP_ENV: "production",
      CHAT_RUNTIME_ENV_FILE: "/does/not/exist",
      CHAT_MODEL_PROVIDER: "pipeline",
      CHAT_MODEL_NAME: "deployed-model",
    });

    expect(profiles[0]?.profile).toMatchObject({
      provider: "pipeline",
      model: "deployed-model",
    });
  });

  it("records every behavior input, pairwise dimension, and exact profile canary", async () => {
    vi.stubEnv("CHAT_MODEL_PROVIDER", "mock");
    const result = await executeCharacterSoulQaEvidence({
      characterContentVersionId: "content-candidate",
      soul: soul("Mara", "warm and direct"),
      peers: [{
        characterId: "peer-character",
        characterContentVersionId: "peer-content",
        soul: soul("Iris", "dry and playful"),
      }],
    });

    expect(result.behaviorEvaluation.cases.map((entry) => entry.key)).toEqual(
      characterSoulBehaviorCaseKeys,
    );
    expect(result.behaviorEvaluation.distinctiveness?.comparisons).toHaveLength(1);
    expect(result.behaviorEvaluation.distinctiveness?.comparisons[0]).toMatchObject({
      peerCharacterId: "peer-character",
      result: "passed",
      dimensions: {
        voice_cadence: true,
        initiative_curiosity: true,
        conflict_repair: true,
        values_promise: true,
        generic_phrase_overlap: true,
      },
    });
    expect(result.liveCanaries).toHaveLength(1);
    expect(result.liveCanaries[0]).toMatchObject({
      provider: "mock",
      adapter: "mock-v1",
      coldStart: false,
      result: "passed",
    });
  });
});
