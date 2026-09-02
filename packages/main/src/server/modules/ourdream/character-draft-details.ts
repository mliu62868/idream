import { legacySoulDetailsMarkdown } from "@idream/shared/chat/persona";
import { z } from "zod";
import { jsonNonBlankString, jsonRecord } from "./json-values";

export const characterDraftVoiceSelectionSchema = z.object({
  provider: z.literal("pocket_tts"),
  voiceId: z.string().trim().min(1).max(160),
}).strict();

export const characterDraftDetailsWriteSchema = z.object({
  description: z.string().trim().max(1_000).optional(),
  detailsMarkdown: z.string().max(24_000).optional(),
  firstMessage: z.string().trim().max(4_000).optional(),
  voiceSelection: characterDraftVoiceSelectionSchema.nullable().optional(),
}).strict();

export type CharacterDraftDetailsWrite = z.infer<
  typeof characterDraftDetailsWriteSchema
>;

export type CurrentCharacterDraftDetails = CharacterDraftDetailsWrite & {
  readonly age?: number;
  readonly submittedCharacterId?: string;
};

/**
 * SPEC: historical draft JSON is adapted once at the read boundary. Every
 * subsequent PATCH writes only the current compact fields plus durable age.
 */
export function readCurrentCharacterDraftDetails(
  value: unknown,
): CurrentCharacterDraftDetails {
  const row = jsonRecord(value);
  const age = Number.isInteger(row.age) && Number(row.age) >= 18 && Number(row.age) <= 120
    ? Number(row.age)
    : undefined;
  const submittedCharacterId = jsonNonBlankString(row.submittedCharacterId);
  const voiceSelection = characterDraftVoiceSelectionSchema.nullable().safeParse(row.voiceSelection);
  return {
    ...(age === undefined ? {} : { age }),
    description: jsonNonBlankString(row.description) ?? "",
    detailsMarkdown: legacySoulDetailsMarkdown(row),
    firstMessage: jsonNonBlankString(row.firstMessage) ?? "",
    ...(voiceSelection.success ? { voiceSelection: voiceSelection.data } : {}),
    ...(submittedCharacterId ? { submittedCharacterId } : {}),
  };
}

export function mergeCurrentCharacterDraftDetails(input: {
  readonly current: unknown;
  readonly patch?: CharacterDraftDetailsWrite;
  readonly age?: number;
}): CurrentCharacterDraftDetails {
  const current = readCurrentCharacterDraftDetails(input.current);
  return {
    ...current,
    ...input.patch,
    ...(input.age === undefined ? {} : { age: input.age }),
  };
}
