import type { ImageModel, ProviderResult } from "../types";

type PipelineImageConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
};

type PipelineImageAsset = {
  key: string;
  width: number;
  height: number;
  body: Uint8Array;
  contentType: string;
};

export class PipelineImageModel implements ImageModel {
  private readonly endpoint: URL;

  constructor(private readonly config: PipelineImageConfig) {
    this.endpoint = pipelineEndpoint(config.baseUrl);
  }

  async generate(
    input: Parameters<ImageModel["generate"]>[0],
  ): Promise<ProviderResult<{ assets: PipelineImageAsset[] }>> {
    const count = Math.max(1, Math.min(input.count, 4));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const size = imageSize(input.controls, input.orientation);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          requestId: input.requestId,
          prompt: input.prompt,
          negativePrompt: input.negativePrompt,
          negative_prompt: input.negativePrompt,
          model: input.model ?? this.config.model,
          orientation: input.orientation,
          size,
          count,
          n: count,
          response_format: "b64_json",
          seed: stableNumericSeed(input.seed),
          controls: { ...(input.controls ?? {}), idreamSeed: input.seed },
        }),
        signal: controller.signal,
      });
      const json = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) return pipelineFailure(json, response.status);
      return { ok: true, data: { assets: parsePipelineResponse(json, count, size, input.requestId) } };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        error: {
          code: aborted ? "timeout" : "internal",
          message: aborted
            ? "Pipeline request timed out"
            : error instanceof Error
              ? error.message
              : "Pipeline request failed",
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function pipelineEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.pathname !== "/" && url.pathname !== "") return url;
  return new URL("/images/generations", url);
}

function imageSize(controls: Record<string, unknown> | undefined, orientation: string | undefined) {
  const width = numericControl(controls, "width");
  const height = numericControl(controls, "height");
  if (width && height) return `${width}x${height}`;
  return orientationToOpenAiSize(orientation);
}

function numericControl(controls: Record<string, unknown> | undefined, key: string) {
  const value = controls?.[key];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  return null;
}

function orientationToOpenAiSize(orientation: string | undefined) {
  switch (orientation) {
    case "16:9":
      return "1024x576";
    case "9:16":
      return "576x1024";
    case "4:5":
      return "768x960";
    case "3:4":
      return "768x1024";
    default:
      return "1024x1024";
  }
}

function parsePipelineResponse(
  value: unknown,
  count: number,
  size: string,
  requestId: string | undefined,
): PipelineImageAsset[] {
  const record = isRecord(value) ? value : {};
  const data = Array.isArray(record.data) ? record.data : [];
  const [width, height] = parseSize(size);
  return data.slice(0, count).flatMap((item, index) => {
    if (!isRecord(item) || typeof item.b64_json !== "string") return [];
    return [
      {
        key:
          typeof item.key === "string"
            ? item.key
            : `pipeline/${requestId ?? "image"}-${index + 1}.png`,
        width,
        height,
        body: base64ToBytes(item.b64_json),
        contentType: "image/png",
      },
    ];
  });
}

function parseSize(size: string) {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return [1024, 1024] as const;
  return [Number.parseInt(match[1] ?? "1024", 10), Number.parseInt(match[2] ?? "1024", 10)] as const;
}

function base64ToBytes(value: string) {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function stableNumericSeed(seed: string | undefined) {
  if (!seed) return undefined;
  const numeric = Number.parseInt(seed, 10);
  if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;

  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pipelineFailure(value: unknown, status: number): ProviderResult<never> {
  const record = isRecord(value) ? value : {};
  const error = isRecord(record.error) ? record.error : record;
  return {
    ok: false,
    error: {
      code: typeof error.code === "string" ? error.code : `http_${status}`,
      message: typeof error.message === "string" ? error.message : "Pipeline request failed",
      retryable: status >= 500 || status === 429,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
