export interface SceneState {
  schemaVersion: 1;
  version: number;
  location: string | null;
  time: string | null;
  participants: string[];
  emotionalBeat: string | null;
  unresolvedThreads: string[];
}

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
  if (!record(value) || value.schemaVersion !== 1) return null;
  if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 0) return null;
  if (!nullableText(value.location) || !nullableText(value.time) || !nullableText(value.emotionalBeat)) return null;
  const participants = textArray(value.participants);
  const unresolvedThreads = textArray(value.unresolvedThreads);
  if (!participants || !unresolvedThreads) return null;
  return {
    schemaVersion: 1,
    version: value.version,
    location: value.location,
    time: value.time,
    participants,
    emotionalBeat: value.emotionalBeat,
    unresolvedThreads,
  };
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

/**
 * Deterministic floor for Scene extraction. A configured semantic extractor may
 * enrich this later, but this keeps scene continuity available without adding a
 * second model call to the memory/relationship extraction job.
 */
export function deriveSceneDelta(input: {
  userText: string;
  assistantText: string;
}): SceneDelta {
  const text = `${input.userText} ${input.assistantText}`.replace(/\s+/g, " ").trim();
  const location = first(
    text.match(/\b(?:in|at|inside)\s+((?:the\s+)?[a-z][a-z -]{2,48}?)(?=[,.!?]|\s+with\b)/i)?.[1],
    text.match(/(?:在|到了)([^，。！？]{2,30})(?=[，。！？]|和|跟)/u)?.[1],
  );
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

function first(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function textArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}
