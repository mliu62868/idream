import {
  characterSoulBehaviorBlockingCases,
  characterSoulBehaviorCaseKeys,
  characterSoulBehaviorEvaluatorVersion,
  type CharacterSoulBehaviorEvaluation,
  type CharacterSoulLiveCanary,
} from "@idream/shared/admin";
import {
  loadCharacterSoulSnapshot,
  requiredChatCanaryProfiles,
} from "@idream/shared";

export function characterSoulQaEvidence(input: {
  characterContentVersionId: string;
  personaSnapshot: unknown;
  result?: "passed" | "failed";
}): {
  behaviorEvaluation: CharacterSoulBehaviorEvaluation;
  liveCanaries: CharacterSoulLiveCanary[];
} {
  const loaded = loadCharacterSoulSnapshot(input.personaSnapshot);
  if (!loaded.ok) throw new Error("test Soul must compile before QA evidence is built");
  const result = input.result ?? "passed";
  return {
    behaviorEvaluation: {
      suiteVersion: "character-soul-behavior-1",
      evaluatorVersion: characterSoulBehaviorEvaluatorVersion,
      characterContentVersionId: input.characterContentVersionId,
      soulFingerprint: loaded.snapshot.compiled.fingerprint,
      compilerVersion: loaded.snapshot.compiled.compilerVersion,
      cases: characterSoulBehaviorCaseKeys.map((key) => ({
        key,
        gate: characterSoulBehaviorBlockingCases.has(key) ? "blocking" : "advisory",
        result,
        evidenceRef: `test://behavior/${key}`,
      })),
    },
    liveCanaries: requiredChatCanaryProfiles(process.env).map(({ tier, profile }) => ({
      tier,
      provider: profile.provider,
      model: profile.model,
      adapter: profile.adapter,
      characterContentVersionId: input.characterContentVersionId,
      soulFingerprint: loaded.snapshot.compiled.fingerprint,
      compilerVersion: loaded.snapshot.compiled.compilerVersion,
      firstTokenMs: 10,
      totalMs: 20,
      coldStart: false,
      result,
      evidenceRef: `test://canary/${tier}/${profile.model}`,
    })),
  };
}
