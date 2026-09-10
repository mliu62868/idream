import { chatSceneStateSchema, type ChatSceneState } from "@idream/shared/contracts";

export type SceneState = ChatSceneState;

export interface SceneDelta {
  location: string | null;
  time: string | null;
  participants: string[];
  emotionalBeat: string | null;
  addUnresolvedThreads: string[];
  resolveUnresolvedThreads: string[];
}

export function emptySceneState(): SceneState {
  return {
    schemaVersion: 1,
    version: 0,
    location: null,
    time: null,
    participants: [],
    emotionalBeat: null,
    unresolvedThreads: [],
  };
}

export function parseSceneState(value: unknown): SceneState | null {
  const parsed = chatSceneStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function applySceneDelta(previous: SceneState, delta: SceneDelta): SceneState {
  const resolved = new Set(delta.resolveUnresolvedThreads.map(normalize));
  const unresolvedThreads = [
    ...previous.unresolvedThreads.filter((item) => !resolved.has(normalize(item))),
    ...delta.addUnresolvedThreads,
  ];
  return {
    schemaVersion: 1,
    version: previous.version + 1,
    location: delta.location ?? previous.location,
    time: delta.time ?? previous.time,
    participants: unique([...previous.participants, ...delta.participants]),
    emotionalBeat: delta.emotionalBeat ?? previous.emotionalBeat,
    unresolvedThreads: unique(unresolvedThreads),
  };
}

export function sceneForReply(input: {
  previous: SceneState;
  userText: string;
  assistantText: string;
}): SceneState {
  // INVARIANT: Main freezes the Scene before this logical Turn. Edit and
  // regenerate both replace the discarded answer from that same anchor, so
  // applying one delta always advances the Scene exactly once.
  return applySceneDelta(
    input.previous,
    deriveSceneDelta({
      userText: input.userText,
      assistantText: input.assistantText,
    }),
  );
}

/**
 * Deterministic floor for Scene extraction. A configured semantic extractor may
 * enrich this later, but this keeps scene continuity available without adding a
 * second model call to the Scene projection job.
 */
export function deriveSceneDelta(input: {
  userText: string;
  assistantText: string;
}): SceneDelta {
  const texts = [input.userText, input.assistantText]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const text = texts.join(" ");
  const locationCandidate = first(
    ...texts.map(extractEnglishLocation),
    ...texts.map(extractChineseLocation),
  );
  const location = locationCandidate && !ABSTRACT_LOCATION_VALUES.has(normalize(locationCandidate))
    ? locationCandidate
    : null;
  const time = first(
    text.match(/\b(tonight|this morning|this afternoon|this evening|at dawn|at dusk|midnight)\b/i)?.[1],
    text.match(/(今晚|今早|今天下午|傍晚|午夜|黎明)/u)?.[1],
  )?.toLowerCase() ?? null;
  const participant = first(
    text.match(/\bwith\s+([A-Z][a-z]{1,30})(?=[,.!?])/u)?.[1],
    text.match(/(?:和|跟)([\p{Script=Han}A-Za-z]{1,20})(?:一起|在)/u)?.[1],
  );
  const emotionalBeat = first(
    text.match(/\b(?:feel|feeling|felt)\s+(nervous|relieved|sad|happy|angry|afraid|hopeful|lonely|calm)\b/i)?.[1],
    text.match(/(?:感到|觉得)(紧张|轻松|难过|开心|生气|害怕|期待|孤独|平静)/u)?.[1],
  )?.toLowerCase() ?? null;
  const unresolved = first(
    text.match(/\b(?:still\s+)?need to\s+([^,.!?]{3,80})/i)?.[1],
    text.match(/还(?:需要|得)([^，。！？]{2,60})/u)?.[1],
  );
  const resolved = first(
    text.match(/\b(?:we|i)\s+(?:decided|resolved|finished)\s+([^,.!?]{3,80})/i)?.[1],
    text.match(/(?:已经|终于)(?:决定|解决|完成)([^，。！？]{2,60})/u)?.[1],
  );
  return {
    location: location ?? null,
    time,
    participants: participant ? [participant] : [],
    emotionalBeat,
    addUnresolvedThreads: unresolved ? [unresolved] : [],
    resolveUnresolvedThreads: resolved ? [resolved] : [],
  };
}

const ABSTRACT_LOCATION_VALUES = new Set([
  "trouble",
  "danger",
  "love",
  "pain",
  "doubt",
  "agreement",
  "conflict",
  "the middle of something",
]);

const ENGLISH_LOCATION_BOUNDARY =
  "(?=[,.!?]|$|\\s+(?:with|while|waiting|thinking|looking|talking|watching|feeling|hoping)\\b)";

function extractEnglishLocation(text: string): string | undefined {
  const present = text.match(new RegExp(
    `\\b(?:we(?:'re| are)|i(?:'m| am)|you(?:'re| are)|they(?:'re| are))\\s+(?:currently\\s+)?(?:in|at|inside)\\s+((?:the\\s+)?[a-z][a-z '\\-]{1,48}?)${ENGLISH_LOCATION_BOUNDARY}`,
    "i",
  ))?.[1];
  const movement = text.match(new RegExp(
    `\\b(?:we|i|you|they)\\s+(?:arrived at|went to|came to)\\s+((?:the\\s+)?[a-z][a-z '\\-]{1,48}?)${ENGLISH_LOCATION_BOUNDARY}`,
    "i",
  ))?.[1];
  return first(present, movement);
}

function extractChineseLocation(text: string): string | undefined {
  const raw = text.match(
    /(?:我们|我|你|他们)(?:现在)?(?:在|到了|来到)([^，。！？\n]{1,30}?)(?=[，。！？]|$)/u,
  )?.[1]?.trim();
  if (!raw || CHINESE_PREDICATE_PREFIX.test(raw)) return undefined;
  const concrete = raw.split(CHINESE_TRAILING_PREDICATE, 1)[0]?.trim();
  return concrete || undefined;
}

const CHINESE_PREDICATE_PREFIX =
  /^(?:想|骗|看|等|问|说|听|爱|喜欢|觉得|考虑|做|工作|学习|吃|喝|睡|忙|找)/u;
const CHINESE_TRAILING_PREDICATE =
  /(?=想|骗|看|等|问|说|听|爱|喜欢|觉得|考虑|工作|学习|吃|喝|睡|找)/u;

function first(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
