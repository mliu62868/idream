import { createVideoMediaProbe as createProbe } from "@idream/shared/media/video-probe";
import { env } from "../env";

export { VideoMediaProbeError } from "@idream/shared/media/video-probe";
export type { VerifiedVideoMedia, VideoMediaProbe, VideoMediaCommandRunner } from "@idream/shared/media/video-probe";

// Preserve the Gen command contract and its preflight-checked runtime paths.
export function createVideoMediaProbe(input: Parameters<typeof createProbe>[0] = {}) {
  return createProbe({ ffprobePath: env.FFPROBE_BIN, ffmpegPath: env.FFMPEG_BIN, ...input });
}
export const probeVideoMedia = createVideoMediaProbe();
