import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createVideoMediaFileProbe } from "@idream/shared/media/video-probe";
import { env } from "@/server/lib/env";

const run = promisify(execFile);

// INTENT: packaging runs on the host that also renders on the GPU, and an uncapped
// ffmpeg takes every core it can see (measured: 10 core-seconds per wall second on a
// 720p fixture, 3.3 with these caps). A user waits a moment longer for packaging
// rather than every other render slowing down.
export const VIDEO_COMPOSITION_ENCODER_THREADS = 2;
const VIDEO_COMPOSITION_DECODER_THREADS = 1;
const VIDEO_COMPOSITION_PROBE_THREADS = 2;
export const VIDEO_COMPOSITION_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

// SPEC: Packaging makes no model requests. Native sound is preserved, silent
// output has no audio stream, and narration replaces the native soundtrack.
// Narration is never cut: hold the final frame until the complete line ends.
// INVARIANT: one ffmpeg command encodes the picture exactly once. Every scene goes
// straight from its source file through the shared filter graph, so a narrated
// scene no longer loses a generation to an intermediate x264 pass.
export async function composeVideoScenes(input: {
  scenes: Array<{ videoPath: string; narrationPath?: string }>;
  audio: "generated" | "silent" | "narration";
  ffmpegBin?: string;
  ffprobeBin?: string;
  maxOutputBytes?: number;
}) {
  if (input.scenes.length < 1 || input.scenes.length > 3) throw new Error("A video sequence needs one to three scenes");
  const ffmpeg = input.ffmpegBin ?? env.VOICE_FFMPEG_BIN;
  const ffprobe = input.ffprobeBin ?? env.VIDEO_FFPROBE_BIN;
  const probe = createVideoMediaFileProbe({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, threads: VIDEO_COMPOSITION_PROBE_THREADS });
  const directory = await mkdtemp(join(tmpdir(), "idream-video-sequence-"));
  const command = (bin: string, args: string[]) => run(bin, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  try {
    const durations: number[] = [];
    const inputs: string[] = [];
    const filters: string[] = [];
    let dimensions: { width: number; height: number } | null = null;
    for (const [index, scene] of input.scenes.entries()) {
      const media = await probe(scene.videoPath);
      if (dimensions && (media.width !== dimensions.width || media.height !== dimensions.height)) throw new Error("Video scenes have different dimensions");
      if (Math.abs(media.framesPerSecond - 24) > 0.05) throw new Error("Video sequence requires its accepted 24fps streams");
      dimensions = { width: media.width, height: media.height };
      const videoInput = inputs.push(scene.videoPath) - 1;
      if (input.audio === "narration") {
        if (!scene.narrationPath) throw new Error("Narration bytes are missing");
        const raw = await command(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", scene.narrationPath]);
        const speech = JSON.parse(raw.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
        const duration = Number(speech.format?.duration);
        if (!Number.isFinite(duration) || duration <= 0 || duration > 30 || !speech.streams?.some(stream => stream.codec_type === "audio")) throw new Error("Narration must be valid audio up to 30 seconds");
        // Native audio can outlast its picture stream, and container duration
        // rounds rational frame times (13/24 becomes .542). Narration replaces
        // that audio, so only decoded picture frames determine the hold point.
        if (media.frameCount === null) throw new Error("Narration requires a decoded picture frame count");
        const pictureFrames = media.frameCount;
        const totalFrames = Math.max(Math.ceil(duration * 24), pictureFrames);
        const seconds = totalFrames / 24;
        durations.push(seconds);
        const speechInput = inputs.push(scene.narrationPath) - 1;
        // Counted in frames, not seconds: a decimal duration can round across a frame
        // boundary, and the hold must land on exactly the accepted frame count.
        filters.push(
          `[${videoInput}:v:0]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=${totalFrames - pictureFrames},trim=end_frame=${totalFrames},setpts=PTS-STARTPTS[v${index}]`,
          `[${speechInput}:a:0]asetpts=PTS-STARTPTS,apad,atrim=duration=${seconds}[a${index}]`,
        );
      } else {
        if (input.audio === "generated" && !media.hasAudio) throw new Error("Generated soundtrack is missing");
        // Silent output discards the native audio, whose trailing samples can
        // make the source container longer than its decoded picture timeline.
        if (input.audio === "silent" && media.frameCount === null) throw new Error("Silent video requires a decoded picture frame count");
        const seconds = input.audio === "silent" ? media.frameCount! / 24 : media.durationSeconds;
        durations.push(seconds);
        filters.push(`[${videoInput}:v:0]setpts=PTS-STARTPTS[v${index}]`);
        // AAC encoder priming makes packet-copy concatenation overlap timestamps.
        // Reset each decoded timeline and pad only to its accepted scene duration.
        if (input.audio === "generated") filters.push(`[${videoInput}:a:0]asetpts=PTS-STARTPTS,apad,atrim=duration=${seconds}[a${index}]`);
      }
    }
    const silent = input.audio === "silent";
    filters.push(`${input.scenes.map((_, index) => `[v${index}]${silent ? "" : `[a${index}]`}`).join("")}concat=n=${input.scenes.length}:v=1:a=${silent ? 0 : 1}[v]${silent ? "" : "[a]"}`);
    const outputPath = join(directory, "sequence.mp4");
    await command(ffmpeg, ["-nostdin", "-v", "error", "-xerror", "-y",
      "-filter_complex_threads", "1",
      ...inputs.flatMap(path => ["-threads", String(VIDEO_COMPOSITION_DECODER_THREADS), "-i", path]),
      "-filter_complex", filters.join(";"), "-map", "[v]", ...(silent ? ["-an"] : ["-map", "[a]", "-c:a", "aac", "-ar", "48000", "-ac", "2"]),
      "-c:v", "libx264", "-threads", String(VIDEO_COMPOSITION_ENCODER_THREADS), "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "24", "-movflags", "+faststart", outputPath]);
    const media = await probe(outputPath);
    if (media.hasAudio !== !silent || Math.abs(media.durationSeconds - durations.reduce((a, b) => a + b, 0)) > 0.25 * input.scenes.length) throw new Error("Packaged video does not match its accepted audio or duration");
    // The store's PUT signs a payload hash, so the output alone stays a buffer. It is
    // read only after the bound passes: this process also owns terminal ingest.
    const { size } = await stat(outputPath);
    if (size > (input.maxOutputBytes ?? VIDEO_COMPOSITION_MAX_OUTPUT_BYTES)) throw new Error("Packaged video is larger than the sequence output bound");
    return { bytes: new Uint8Array(await readFile(outputPath)), media, sceneDurations: durations };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
