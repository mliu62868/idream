import { randomUUID } from "node:crypto";
import type { BlobStore, ProviderResult, VoiceModel } from "../types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PipelineVoiceModelConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Speaker used when a character has no voiceId. Model-specific (e.g. "serena"
   *  for Qwen3-TTS); the generic "default" 500s on speaker-keyed TTS servers. */
  defaultVoiceId?: string;
  /** Some OpenAI-compatible local TTS gateways accept `instructions` but degrade
   *  audio when it is present. Keep persona instructions opt-in per deployment. */
  sendInstructions?: boolean;
  /** Local TTS models often degrade on long prompts. Split text into smaller
   *  requests and merge WAV chunks; 0 disables chunking. */
  maxInputCharsPerRequest?: number;
  /** Trim long TTS text before synthesis. Sentence boundaries are preferred so
   *  local voice models do not speak a sentence split across requests. */
  maxInputChars?: number;
  timeoutMs?: number;
  blob: BlobStore;
  fetchImpl?: FetchLike;
}

type BinarySpeechChunk = {
  kind: "binary";
  body: Uint8Array;
  contentType: string;
};

type JsonSpeechChunk = {
  kind: "json";
  data: { key: string; durationMs: number };
};

type SpeechChunk = BinarySpeechChunk | JsonSpeechChunk;

export class PipelineVoiceModel implements VoiceModel {
  readonly providerKey = "pipeline" as const;
  readonly supportsVoiceCloning = false;

  private readonly endpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly defaultVoiceId: string;
  private readonly sendInstructions: boolean;
  private readonly maxInputCharsPerRequest: number;
  private readonly maxInputChars: number;
  private readonly timeoutMs: number;
  private readonly blob: BlobStore;
  private readonly fetchImpl: FetchLike;

  constructor(config: PipelineVoiceModelConfig) {
    this.endpoint = pipelineEndpoint(config.baseUrl, "/audio/speech");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.defaultVoiceId = config.defaultVoiceId?.trim() || "default";
    this.sendInstructions = config.sendInstructions === true;
    this.maxInputCharsPerRequest = Math.max(0, config.maxInputCharsPerRequest ?? 0);
    this.maxInputChars = Math.max(0, config.maxInputChars ?? 900);
    this.timeoutMs = Math.max(250, config.timeoutMs ?? 60_000);
    this.blob = config.blob;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async synthesize(input: Parameters<VoiceModel["synthesize"]>[0]) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const rendered: SpeechChunk[] = [];
      const voiceText = limitVoiceText(input.text, this.maxInputChars);
      for (const chunk of splitVoiceText(voiceText, this.maxInputCharsPerRequest)) {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.model,
            input: chunk,
            voice: input.voiceId ?? this.defaultVoiceId,
            response_format: "wav",
            ...(this.sendInstructions && input.tone ? { instructions: input.tone } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) return voiceFailure(response.status);
        rendered.push(await parseSpeechChunk(response));
      }

      if (rendered.length === 1 && rendered[0]?.kind === "json") {
        return { ok: true as const, data: rendered[0].data };
      }
      if (rendered.some((chunk) => chunk.kind === "json")) {
        return {
          ok: false as const,
          error: {
            code: "invalid_voice_response",
            message: "Pipeline voice chunking requires binary audio responses",
            retryable: true,
          },
        };
      }

      const combined = combineSpeechChunks(rendered as BinarySpeechChunk[]);
      if (!combined.ok) return combined;
      const { body, contentType, durationMs } = combined.data;
      const key = `voice/${randomUUID()}${audioFileExtension(contentType)}`;
      const stored = await this.blob.putPrivate({ key, body, contentType });
      if (!stored.ok) return stored;
      return {
        ok: true as const,
        data: {
          key,
          durationMs: durationMs ?? estimateDurationMs(voiceText),
        },
      };
    } catch (error) {
      return {
        ok: false as const,
        error: {
          code:
            error instanceof Error && error.name === "AbortError"
              ? "voice_timeout"
              : "voice_request_failed",
          message: error instanceof Error ? error.message : "Pipeline voice request failed",
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function parseSpeechChunk(response: Response): Promise<SpeechChunk> {
  const contentType = response.headers.get("content-type") ?? "audio/mpeg";
  if (contentType.includes("application/json")) {
    const json = (await response.json().catch(() => ({}))) as unknown;
    const parsed = parseJsonVoiceResult(json);
    if (parsed) return { kind: "json", data: parsed };
    throw new Error("Pipeline voice response missing key");
  }

  return {
    kind: "binary",
    body: new Uint8Array(await response.arrayBuffer()),
    contentType,
  };
}

function combineSpeechChunks(chunks: BinarySpeechChunk[]): ProviderResult<{
  body: Uint8Array;
  contentType: string;
  durationMs: number | undefined;
}> {
  if (chunks.length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid_voice_response",
        message: "Pipeline voice response was empty",
        retryable: true,
      },
    };
  }
  if (chunks.length === 1) {
    const chunk = chunks[0]!;
    return {
      ok: true,
      data: {
        body: chunk.body,
        contentType: chunk.contentType,
        durationMs: measuredDurationMs(chunk.body, chunk.contentType),
      },
    };
  }

  const wavChunks = chunks.map((chunk) => parseWavChunk(chunk.body));
  if (wavChunks.some((chunk) => !chunk)) {
    return {
      ok: false,
      error: {
        code: "invalid_voice_response",
        message: "Pipeline voice chunking requires WAV audio responses",
        retryable: true,
      },
    };
  }
  const wavs = wavChunks as WavChunk[];
  const first = wavs[0]!;
  const compatible = wavs.every(
    (chunk) =>
      chunk.audioFormat === first.audioFormat &&
      chunk.numChannels === first.numChannels &&
      chunk.sampleRate === first.sampleRate &&
      chunk.byteRate === first.byteRate &&
      chunk.blockAlign === first.blockAlign &&
      chunk.bitsPerSample === first.bitsPerSample,
  );
  if (!compatible) {
    return {
      ok: false,
      error: {
        code: "invalid_voice_response",
        message: "Pipeline voice chunks used incompatible WAV formats",
        retryable: true,
      },
    };
  }

  const body = encodeWav(wavs, 180);
  return {
    ok: true,
    data: {
      body,
      contentType: "audio/wav",
      durationMs: wavDurationMs(body),
    },
  };
}

type WavChunk = {
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  data: Uint8Array;
};

function parseWavChunk(body: Uint8Array): WavChunk | undefined {
  if (
    body.byteLength < 44 ||
    !asciiEquals(body, 0, "RIFF") ||
    !asciiEquals(body, 8, "WAVE")
  ) {
    return undefined;
  }

  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset = 12;
  let fmt: Omit<WavChunk, "data"> | undefined;
  let data: Uint8Array | undefined;
  while (offset + 8 <= body.byteLength) {
    const chunkId = asciiString(body, offset, offset + 4);
    const declaredSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const availableSize = Math.max(0, Math.min(declaredSize, body.byteLength - dataOffset));

    if (chunkId === "fmt " && availableSize >= 16) {
      fmt = {
        audioFormat: view.getUint16(dataOffset, true),
        numChannels: view.getUint16(dataOffset + 2, true),
        sampleRate: view.getUint32(dataOffset + 4, true),
        byteRate: view.getUint32(dataOffset + 8, true),
        blockAlign: view.getUint16(dataOffset + 12, true),
        bitsPerSample: view.getUint16(dataOffset + 14, true),
      };
    } else if (chunkId === "data") {
      data = body.slice(dataOffset, dataOffset + availableSize);
    }

    if (fmt && data) break;
    const nextOffset = dataOffset + declaredSize + (declaredSize % 2);
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  return fmt && data ? { ...fmt, data } : undefined;
}

function encodeWav(chunks: WavChunk[], silenceMs: number) {
  const first = chunks[0]!;
  const silenceBytes = Math.round((first.sampleRate * silenceMs) / 1_000) * first.blockAlign;
  const dataSize = chunks.reduce(
    (sum, chunk, index) => sum + chunk.data.byteLength + (index > 0 ? silenceBytes : 0),
    0,
  );
  const body = new Uint8Array(44 + dataSize);
  const view = new DataView(body.buffer);
  writeAscii(body, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(body, 8, "WAVE");
  writeAscii(body, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, first.audioFormat, true);
  view.setUint16(22, first.numChannels, true);
  view.setUint32(24, first.sampleRate, true);
  view.setUint32(28, first.byteRate, true);
  view.setUint16(32, first.blockAlign, true);
  view.setUint16(34, first.bitsPerSample, true);
  writeAscii(body, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) offset += silenceBytes;
    body.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  return body;
}

function writeAscii(body: Uint8Array, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) {
    body[offset + i] = value.charCodeAt(i);
  }
}

function splitVoiceText(text: string, maxChars: number) {
  const normalized = normalizeVoiceText(text);
  if (!normalized) return [text];
  if (maxChars <= 0 || normalized.length <= maxChars) return [normalized];
  const chunks = sentenceSegments(normalized, maxChars);
  return chunks.length > 0 ? chunks : [normalized];
}

function limitVoiceText(text: string, maxChars: number) {
  const normalized = normalizeVoiceText(text);
  if (!normalized || maxChars <= 0 || normalized.length <= maxChars) {
    return normalized || text;
  }

  const sentences = sentenceUnits(normalized);
  let selected = "";
  for (const sentence of sentences) {
    const next = selected ? `${selected} ${sentence}` : sentence;
    if (next.length > maxChars) break;
    selected = next;
  }
  if (selected) return selected;

  const firstSentence = sentences[0] ?? normalized;
  return trimLongSentence(firstSentence, maxChars);
}

function normalizeVoiceText(text: string) {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\.{2,}/g, ".")
    .replace(/…+/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceSegments(text: string, maxChars: number) {
  return sentenceUnits(text)
    .flatMap((segment) => splitLongSegment(segment.trim(), maxChars))
    .filter(Boolean);
}

function sentenceUnits(text: string) {
  const matches = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/gu);
  return (matches ?? [text]).map((segment) => segment.trim()).filter(Boolean);
}

function splitLongSegment(segment: string, maxChars: number) {
  if (segment.length <= maxChars) return [segment];
  const clauses = segment.split(/(?<=[,;:，；：])\s+/u);
  const chunks: string[] = [];
  let current = "";
  for (const clause of clauses) {
    if (clause.length > maxChars) {
      if (current) chunks.push(current);
      chunks.push(...splitByWords(clause, maxChars));
      current = "";
      continue;
    }
    const next = current ? `${current} ${clause}` : clause;
    if (next.length <= maxChars) current = next;
    else {
      if (current) chunks.push(current);
      current = clause;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function trimLongSentence(sentence: string, maxChars: number) {
  const clauses = sentence.split(/(?<=[,;:，；：])\s*/u).filter(Boolean);
  let selected = "";
  for (const clause of clauses) {
    const next = selected ? `${selected} ${clause}` : clause;
    if (next.length > maxChars) break;
    selected = next;
  }
  if (selected) return selected;
  return trimAtWordBoundary(sentence, maxChars);
}

function trimAtWordBoundary(text: string, maxChars: number) {
  const clipped = text.slice(0, maxChars).trim();
  const lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxChars * 0.6)) return clipped.slice(0, lastSpace).trim();
  return clipped;
}

function splitByWords(segment: string, maxChars: number) {
  const chunks: string[] = [];
  let current = "";
  for (const word of segment.split(/\s+/u)) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) current = next;
    else {
      if (current) chunks.push(current);
      current = word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function parseJsonVoiceResult(value: unknown) {
  const record = asRecord(value);
  const nested = asRecord(record.audio);
  const key = stringField(record, "key") ?? stringField(nested, "key");
  if (!key) return undefined;
  return {
    key,
    durationMs:
      numberField(record, "durationMs") ??
      numberField(record, "duration_ms") ??
      numberField(nested, "durationMs") ??
      numberField(nested, "duration_ms") ??
      0,
  };
}

function voiceFailure(status: number): ProviderResult<never> {
  return {
    ok: false,
    error: {
      code: status === 429 ? "voice_rate_limited" : "voice_request_failed",
      message: `Pipeline voice request failed with HTTP ${status}`,
      retryable: status === 408 || status === 429 || status >= 500,
    },
  };
}

function estimateDurationMs(text: string) {
  return Math.max(500, text.length * 35);
}

function measuredDurationMs(body: Uint8Array, contentType: string) {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "audio/wav" && mediaType !== "audio/x-wav") return undefined;
  return wavDurationMs(body);
}

function wavDurationMs(body: Uint8Array) {
  if (
    body.byteLength < 44 ||
    !asciiEquals(body, 0, "RIFF") ||
    !asciiEquals(body, 8, "WAVE")
  ) {
    return undefined;
  }

  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= body.byteLength) {
    const chunkId = asciiString(body, offset, offset + 4);
    const declaredSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const availableSize = Math.max(0, Math.min(declaredSize, body.byteLength - dataOffset));

    if (chunkId === "fmt " && availableSize >= 16) {
      byteRate = view.getUint32(dataOffset + 8, true);
    } else if (chunkId === "data") {
      dataSize = availableSize;
    }

    if (byteRate > 0 && dataSize > 0) break;
    const nextOffset = dataOffset + declaredSize + (declaredSize % 2);
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (byteRate <= 0 || dataSize <= 0) return undefined;
  const durationMs = Math.round((dataSize / byteRate) * 1_000);
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined;
}

function asciiEquals(body: Uint8Array, offset: number, expected: string) {
  return asciiString(body, offset, offset + expected.length) === expected;
}

function asciiString(body: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...body.subarray(start, end));
}

function audioFileExtension(contentType: string) {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  const extensions: Record<string, string> = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/flac": ".flac",
    "audio/webm": ".webm",
  };
  return mediaType ? (extensions[mediaType] ?? ".bin") : ".bin";
}

function pipelineEndpoint(baseUrl: string, suffix: string) {
  const url = new URL(baseUrl);
  if (url.pathname.endsWith(suffix)) return url;
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}${suffix}`;
  return url;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
