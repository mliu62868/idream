import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { env } from "../env";

const run = promisify(execFile);
export type VideoContainerFinalizer = (bytes: Uint8Array, media: { readonly hasAudio: boolean }) => Promise<Uint8Array>;

// SPEC: every delivered MP4 leaves here remuxed: no container metadata, moov first.
// INTENT: ComfyUI's SaveVideo writes the whole prompt and workflow into MP4 tags,
// including the user's text and our model file names, and only the loudness path
// used to re-encode them away. Playback also needs moov before mdat on slow links.
//
// Native generation can also deliver a valid soundtrack at inaudible levels. Use
// measured loudness normalization: uniform gain when peaks allow it, otherwise
// smooth local gain so brief transients do not keep the track quiet. Copy video
// packets and never synthesize missing sounds.
export const finalizeVideoContainer: VideoContainerFinalizer = async (bytes, { hasAudio }) => {
  const directory = await mkdtemp(join(tmpdir(), "idream-video-soundtrack-"));
  const source = join(directory, "source.mp4"), output = join(directory, "output.mp4");
  const command = (args: string[]) => run(env.FFMPEG_BIN, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const container = ["-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", output];
  const remuxOnly = async () => {
    await command(["-nostdin", "-v", "error", "-xerror", "-y", "-i", source, "-map", "0:v:0", ...(hasAudio ? ["-map", "0:a:0"] : []), "-c", "copy", ...container]);
    return new Uint8Array(await readFile(output));
  };
  const measure = async (prefix: string) => {
    const { stderr } = await command(["-nostdin", "-hide_banner", "-i", source, "-map", "0:a:0", "-af", `${prefix}loudnorm=I=-18:TP=-2:LRA=50:print_format=json`, "-f", "null", "-"]);
    const measured = JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1)) as {
      input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string;
    };
    // Below the loudness gate there is no reliable signal to normalize. Keep
    // digital silence and the noise floor instead of inventing audible content.
    if (measured.input_i === "-inf") return null;
    const levels = {
      loudness: Number(measured.input_i), peak: Number(measured.input_tp), range: Number(measured.input_lra),
      threshold: Number(measured.input_thresh), offset: Number(measured.target_offset),
    };
    if (!Object.values(levels).every(Number.isFinite)) throw new Error("Native soundtrack loudness could not be measured");
    return levels;
  };
  try {
    await writeFile(source, bytes);
    if (!hasAudio) return await remuxOnly();
    let prefix = "", levels = await measure(prefix);
    if (!levels) return await remuxOnly();
    if (Math.abs(-18 - levels.loudness) <= 0.25 && levels.peak <= -2) return await remuxOnly();
    if (-18 - levels.loudness > -2 - levels.peak) {
      prefix = "dynaudnorm=f=150:g=5:p=0.8:m=100:r=0.125:s=5,";
      levels = await measure(prefix);
      if (!levels) throw new Error("Native soundtrack loudness could not be measured");
    }
    const { loudness, peak, range, threshold, offset } = levels;
    await command(["-nostdin", "-v", "error", "-xerror", "-y", "-i", source, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
      // Bound filter latency to the complete video, including when native
      // audio ends earlier. Silence padding prevents -shortest dropping frames.
      "-af", `${prefix}loudnorm=I=-18:TP=-2:LRA=50:measured_I=${loudness}:measured_TP=${peak}:measured_LRA=${range}:measured_thresh=${threshold}:offset=${offset}:linear=true,apad`,
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-shortest", ...container]);
    return new Uint8Array(await readFile(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
};
