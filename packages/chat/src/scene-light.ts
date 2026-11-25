/**
 * Lightweight single-call Scene projector designed for asynchronous post-commit
 * execution (never on the synchronous reply hot path).
 *
 * Replaces the discontinued 2-4 serial formal-logic extraction passes in
 * `scene.ts` with one compact JSON-schema delta over the 5 canonical
 * `ChatSceneState` slots. Unchanged fields remain untouched; any model or
 * parse failure fails soft by returning the prior Scene with version + 1.
 */
import { chatSceneStateSchema, type ChatSceneState } from "@idream/shared/contracts";
import { z } from "zod";
import type { PreparedTurnProfile } from "./agent-runtime/contracts.js";
import { OpenAiCompatibleAdapter, type OpenAiCompatibleAdapterOptions } from "./agent-runtime/openai-adapter.js";
import { messageText } from "./agent-runtime/pi-context.js";
import type { InferencePriorityGate } from "./agent-runtime/execution-scheduler.js";

const MAX_SCALAR_CHARS = 160;
const MAX_LIST_ITEMS = 8;

const sceneDeltaSchema = z.object({
  location: z.string().trim().max(MAX_SCALAR_CHARS).nullable().optional(),
  time: z.string().trim().max(MAX_SCALAR_CHARS).nullable().optional(),
  emotionalBeat: z.string().trim().max(MAX_SCALAR_CHARS).nullable().optional(),
  participantsAdd: z.array(z.string().trim().min(1).max(80)).max(MAX_LIST_ITEMS).default([]),
  participantsRemove: z.array(z.string().trim().min(1).max(80)).max(MAX_LIST_ITEMS).default([]),
  threadsAdd: z.array(z.string().trim().min(1).max(MAX_SCALAR_CHARS)).max(MAX_LIST_ITEMS).default([]),
  threadsResolve: z.array(z.string().trim().min(1).max(MAX_SCALAR_CHARS)).max(MAX_LIST_ITEMS).default([]),
}).strict();

export type LightweightSceneDelta = z.infer<typeof sceneDeltaSchema>;

export const LIGHTWEIGHT_SCENE_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "lightweight_scene_delta",
    strict: true as const,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "location",
        "time",
        "emotionalBeat",
        "participantsAdd",
        "participantsRemove",
        "threadsAdd",
        "threadsResolve",
      ],
      properties: {
        location: { anyOf: [{ type: "string", maxLength: MAX_SCALAR_CHARS }, { type: "null" }] },
        time: { anyOf: [{ type: "string", maxLength: MAX_SCALAR_CHARS }, { type: "null" }] },
        emotionalBeat: { anyOf: [{ type: "string", maxLength: MAX_SCALAR_CHARS }, { type: "null" }] },
        participantsAdd: { type: "array", maxItems: MAX_LIST_ITEMS, items: { type: "string", maxLength: 80 } },
        participantsRemove: { type: "array", maxItems: MAX_LIST_ITEMS, items: { type: "string", maxLength: 80 } },
        threadsAdd: { type: "array", maxItems: MAX_LIST_ITEMS, items: { type: "string", maxLength: MAX_SCALAR_CHARS } },
        threadsResolve: { type: "array", maxItems: MAX_LIST_ITEMS, items: { type: "string", maxLength: MAX_SCALAR_CHARS } },
      },
    },
  },
};

export const LIGHTWEIGHT_SCENE_PROMPT = [
  "Update the current roleplay Scene card from ONE completed turn (user message + character reply).",
  "Return ONLY JSON matching the schema. Never invent changes that were not explicitly established as happening right now.",
  "Set location, time, or emotionalBeat to the new concise value ONLY when explicitly changed in this turn; otherwise return null to keep the existing value.",
  "Ignore past memories, hypotheticals, wishes, or quoted text when updating current state.",
  "Use participantsAdd / participantsRemove only for named people who explicitly arrived or left the current scene.",
  "Use threadsAdd for a newly agreed-upon ongoing activity/commitment, and threadsResolve only when an existing open thread was explicitly completed or cancelled.",
].join(" ");

export function applyLightweightSceneDelta(
  previous: ChatSceneState,
  delta: LightweightSceneDelta,
): { scene: ChatSceneState; applied: boolean } {
  const nextLocation = delta.location && delta.location.trim() ? delta.location.trim() : previous.location;
  const nextTime = delta.time && delta.time.trim() ? delta.time.trim() : previous.time;
  const nextBeat = delta.emotionalBeat && delta.emotionalBeat.trim() ? delta.emotionalBeat.trim() : previous.emotionalBeat;

  const removeParticipants = new Set(delta.participantsRemove.map(normalizeKey));
  const participantsAll: string[] = [];
  const seenParticipants = new Set<string>();
  for (const name of [...previous.participants, ...delta.participantsAdd]) {
    const trimmed = name.trim();
    const key = normalizeKey(trimmed);
    if (!key || removeParticipants.has(key) || seenParticipants.has(key)) continue;
    seenParticipants.add(key);
    participantsAll.push(trimmed);
  }
  const participants = participantsAll.slice(-MAX_LIST_ITEMS);

  const resolvedThreads = new Set(delta.threadsResolve.map(normalizeKey));
  const unresolvedThreadsAll: string[] = [];
  const seenThreads = new Set<string>();
  for (const thread of [...previous.unresolvedThreads, ...delta.threadsAdd]) {
    const trimmed = thread.trim();
    const key = normalizeKey(trimmed);
    if (!key || resolvedThreads.has(key) || seenThreads.has(key)) continue;
    seenThreads.add(key);
    unresolvedThreadsAll.push(trimmed);
  }
  const unresolvedThreads = unresolvedThreadsAll.slice(-MAX_LIST_ITEMS);

  const applied = nextLocation !== previous.location
    || nextTime !== previous.time
    || nextBeat !== previous.emotionalBeat
    || JSON.stringify(participants) !== JSON.stringify(previous.participants)
    || JSON.stringify(unresolvedThreads) !== JSON.stringify(previous.unresolvedThreads);

  const scene = chatSceneStateSchema.parse({
    schemaVersion: 1,
    version: previous.version + 1,
    location: nextLocation,
    time: nextTime,
    participants,
    emotionalBeat: nextBeat,
    unresolvedThreads,
  });
  return { scene, applied };
}

export interface ProjectLightweightSceneInput {
  previous: ChatSceneState;
  userText: string;
  assistantText: string;
  characterName: string;
  profile: PreparedTurnProfile;
  apiKey: string;
  openRouterProviderOnly?: readonly string[];
  fetch?: OpenAiCompatibleAdapterOptions["fetch"];
  signal?: AbortSignal;
  priorityGate?: InferencePriorityGate;
}

export interface ProjectLightweightSceneResult {
  scene: ChatSceneState;
  applied: boolean;
  degraded: boolean;
}

/**
 * Run one bounded background Scene projection call. Fails soft on timeout or
 * invalid JSON so Scene tracking never causes a Turn failure.
 */
export async function projectLightweightScene(
  input: ProjectLightweightSceneInput,
): Promise<ProjectLightweightSceneResult> {
  const unchanged = (): ProjectLightweightSceneResult => ({
    scene: chatSceneStateSchema.parse({
      ...input.previous,
      version: input.previous.version + 1,
      participants: [...input.previous.participants],
      unresolvedThreads: [...input.previous.unresolvedThreads],
    }),
    applied: false,
    degraded: true,
  });

  if (!input.userText.trim() && !input.assistantText.trim()) {
    return { ...unchanged(), degraded: false };
  }

  try {
    await input.priorityGate?.waitForBackgroundSlot(input.signal);
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        ...input.profile,
        maxOutputTokens: Math.min(input.profile.maxOutputTokens, 320),
        answerMaxOutputTokens: Math.min(input.profile.maxOutputTokens, 320),
      },
      apiKey: input.apiKey,
      openRouterProviderOnly: input.openRouterProviderOnly,
      samplingTemperature: 0,
      responseFormat: LIGHTWEIGHT_SCENE_RESPONSE_FORMAT,
      fetch: input.fetch,
    });
    const message = await adapter.stream([
      { role: "system", content: LIGHTWEIGHT_SCENE_PROMPT, timestamp: 1 },
      {
        role: "user",
        content: JSON.stringify({
          characterName: input.characterName,
          currentScene: {
            location: input.previous.location,
            time: input.previous.time,
            participants: input.previous.participants,
            emotionalBeat: input.previous.emotionalBeat,
            unresolvedThreads: input.previous.unresolvedThreads,
          },
          userText: input.userText.slice(0, 2_000),
          assistantText: input.assistantText.slice(0, 2_000),
        }),
        timestamp: 1,
      },
    ], {
      maxTokens: 320,
      signal: input.signal,
    }).result();

    if (message.stopReason !== "stop") return unchanged();
    const raw = messageText(message).trim();
    if (!raw) return unchanged();
    const parsed = sceneDeltaSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return unchanged();
    const updated = applyLightweightSceneDelta(input.previous, parsed.data);
    return { ...updated, degraded: false };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return unchanged();
  }
}

function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}
