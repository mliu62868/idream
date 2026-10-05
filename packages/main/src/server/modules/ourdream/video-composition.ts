import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createVideoMediaProbe } from "@idream/shared/media/video-probe";
import { env } from "@/server/lib/env";

const run = promisify(execFile);

// SPEC: Packaging makes no model requests. Native sound is preserved, silent
// output has no audio stream, and narration replaces the native soundtrack.
// Narration is never cut: hold the final frame until the complete line ends.
export async function composeVideoScenes(input: {
  scenes: Array<{ video: Uint8Array; narration?: Uint8Array }>;
  audio: "generated" | "silent" | "narration";
  ffmpegBin?: string;
  ffprobeBin?: string;
}) {
  if (input.scenes.length < 1 || input.scenes.length > 3) throw new Error("A video sequence needs one to three scenes");
  const ffmpeg = input.ffmpegBin ?? env.VOICE_FFMPEG_BIN;
  const ffprobe = input.ffprobeBin ?? env.VIDEO_FFPROBE_BIN;
  const probe = createVideoMediaProbe({ ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const directory = await mkdtemp(join(tmpdir(), "idream-video-sequence-"));
  const command = (bin: string, args: string[]) => run(bin, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  try {
    const segments: string[] = [];
    const durations: number[] = [];
    let dimensions: { width: number; height: number } | null = null;
    for (const [index, scene] of input.scenes.entries()) {
      const media = await probe(scene.video);
      if (dimensions && (media.width !== dimensions.width || media.height !== dimensions.height)) throw new Error("Video scenes have different dimensions");
      if (Math.abs(media.framesPerSecond - 24) > 0.05) throw new Error("Video sequence requires its accepted 24fps streams");
      dimensions = { width: media.width, height: media.height };
      const videoPath = join(directory, `source-${index}.mp4`);
      const outputPath = join(directory, `scene-${index}.mp4`);
      await writeFile(videoPath, scene.video);
      const args = ["-nostdin", "-v", "error", "-xerror", "-y", "-i", videoPath];
      if (input.audio === "narration") {
        if (!scene.narration?.length) throw new Error("Narration bytes are missing");
        const speechPath = join(directory, `speech-${index}.wav`);
        await writeFile(speechPath, scene.narration);
        const raw = await command(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", speechPath]);
        const speech = JSON.parse(raw.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
        const duration = Number(speech.format?.duration);
        if (!Number.isFinite(duration) || duration <= 0 || duration > 30 || !speech.streams?.some(stream => stream.codec_type === "audio")) throw new Error("Narration must be valid audio up to 30 seconds");
        // Native audio can outlast its picture stream, and container duration
        // rounds rational frame times (13/24 becomes .542). Narration replaces
        // that audio, so only decoded picture frames determine the hold point.
        if (media.frameCount === null) throw new Error("Narration requires a decoded picture frame count");
        const pictureFrames = media.frameCount;
        const pictureSeconds = pictureFrames / 24;
        const seconds = Math.max(Math.ceil(duration * 24), pictureFrames) / 24;
        durations.push(seconds);
        args.push("-i", speechPath, "-map", "0:v:0", "-map", "1:a:0", "-vf", `setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${Math.max(0, seconds - pictureSeconds)}`,
          "-af", "asetpts=PTS-STARTPTS,apad", "-t", String(seconds), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2");
      } else {
        if (input.audio === "generated" && !media.hasAudio) throw new Error("Generated soundtrack is missing");
        // Silent output discards the native audio, whose trailing samples can
        // make the source container longer than its decoded picture timeline.
        if (input.audio === "silent" && media.frameCount === null) throw new Error("Silent video requires a decoded picture frame count");
        durations.push(input.audio === "silent" ? media.frameCount! / 24 : media.durationSeconds);
        args.push("-map", "0:v:0", ...(input.audio === "silent" ? ["-an"] : ["-map", "0:a:0"]), "-c", "copy");
      }
      args.push("-movflags", "+faststart", outputPath);
      await command(ffmpeg, args);
      segments.push(outputPath);
    }
    const outputPath = join(directory, "sequence.mp4");
    // AAC encoder priming makes packet-copy concatenation overlap timestamps.
    // Reset each decoded timeline and pad only to its accepted scene duration.
    const filters = segments.flatMap((_, index) => [
      `[${index}:v:0]setpts=PTS-STARTPTS[v${index}]`,
      ...(input.audio === "silent" ? [] : [`[${index}:a:0]asetpts=PTS-STARTPTS,apad,atrim=duration=${durations[index]}[a${index}]`]),
    ]);
    filters.push(`${segments.map((_, index) => `[v${index}]${input.audio === "silent" ? "" : `[a${index}]`}`).join("")}concat=n=${segments.length}:v=1:a=${input.audio === "silent" ? 0 : 1}[v]${input.audio === "silent" ? "" : "[a]"}`);
    await command(ffmpeg, ["-nostdin", "-v", "error", "-xerror", "-y", ...segments.flatMap(path => ["-i", path]),
      "-filter_complex", filters.join(";"), "-map", "[v]", ...(input.audio === "silent" ? ["-an"] : ["-map", "[a]", "-c:a", "aac", "-ar", "48000", "-ac", "2"]),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "24", "-movflags", "+faststart", outputPath]);
    const bytes = new Uint8Array(await readFile(outputPath));
    const media = await probe(bytes);
    if (media.hasAudio !== (input.audio !== "silent") || Math.abs(media.durationSeconds - durations.reduce((a, b) => a + b, 0)) > 0.25 * input.scenes.length) throw new Error("Packaged video does not match its accepted audio or duration");
    return { bytes, media, sceneDurations: durations };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
