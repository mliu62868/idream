import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { env } from "../env";

const execFileAsync = promisify(execFile);
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

export type VerifiedVideoMedia = {
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly framesPerSecond: number;
  readonly hasAudio: boolean;
};

export type VideoMediaProbe = (
  bytes: Uint8Array,
) => Promise<VerifiedVideoMedia>;

export type VideoMediaCommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<string>;

export class VideoMediaProbeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VideoMediaProbeError";
  }
}

// SPEC: accepting a generated video requires both container metadata and a
// successful full decode. ffprobe supplies the actual stream envelope; ffmpeg
// catches truncated/corrupt payloads that still carry a parseable MP4 header.
// Missing verification tools fail closed because unverified bytes may never
// reach blob persistence or a terminal success record.
export function createVideoMediaProbe(input: {
  readonly runner?: VideoMediaCommandRunner;
  readonly ffprobePath?: string;
  readonly ffmpegPath?: string;
  readonly timeoutMs?: number;
} = {}): VideoMediaProbe {
  const runner = input.runner ?? runMediaCommand;
  // env, not a second `process.env.GEN_FF*_BIN ?? "ff*"` — preflight.ts checks
  // these same two binaries exist, and it has to check the ones this runs.
  const ffprobePath = input.ffprobePath ?? env.FFPROBE_BIN;
  const ffmpegPath = input.ffmpegPath ?? env.FFMPEG_BIN;
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return async (bytes) => {
    if (bytes.byteLength === 0) {
      throw new VideoMediaProbeError("Generated video is empty");
    }
    const directory = await mkdtemp(join(tmpdir(), "idream-video-probe-"));
    const path = join(directory, "artifact.mp4");
    try {
      await writeFile(path, bytes);
      let rawMetadata: string;
      try {
        rawMetadata = await runner(ffprobePath, [
          "-v",
          "error",
          "-count_frames",
          "-show_entries",
          "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,nb_frames,nb_read_frames",
          "-of",
          "json",
          path,
        ], { timeoutMs });
      } catch (error) {
        throw new VideoMediaProbeError(
          `ffprobe could not verify generated video: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      const metadata = parseVideoMediaMetadata(rawMetadata);
      try {
        await runner(ffmpegPath, [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-i",
          path,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-f",
          "null",
          "-",
        ], { timeoutMs });
      } catch (error) {
        throw new VideoMediaProbeError(
          `ffmpeg could not fully decode generated video: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      return metadata;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export const probeVideoMedia = createVideoMediaProbe();

function parseVideoMediaMetadata(raw: string): VerifiedVideoMedia {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new VideoMediaProbeError("ffprobe returned malformed JSON", {
      cause: error,
    });
  }
  const root = recordValue(parsed);
  const streams = Array.isArray(root.streams)
    ? root.streams.map(recordValue)
    : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) {
    throw new VideoMediaProbeError("Generated media has no decodable video stream");
  }
  const width = positiveInteger(video.width);
  const height = positiveInteger(video.height);
  const framesPerSecond = positiveRate(video.avg_frame_rate) ??
    positiveRate(video.r_frame_rate);
  const format = recordValue(root.format);
  const durationSeconds = positiveNumber(format.duration) ??
    positiveNumber(video.duration);
  if (!width || !height || !framesPerSecond || !durationSeconds) {
    throw new VideoMediaProbeError(
      "Generated video metadata lacks width, height, duration, or frame rate",
    );
  }
  return {
    width,
    height,
    durationSeconds,
    framesPerSecond,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

async function runMediaCommand(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) {
  const result = await execFileAsync(command, [...args], {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

function positiveInteger(value: unknown) {
  const number = positiveNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function positiveNumber(value: unknown) {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveRate(value: unknown) {
  if (typeof value === "number") return positiveNumber(value);
  if (typeof value !== "string") return null;
  const [numerator, denominator = "1"] = value.split("/");
  const top = Number(numerator);
  const bottom = Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= 0) {
    return null;
  }
  return positiveNumber(top / bottom);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
