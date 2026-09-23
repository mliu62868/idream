import { spawn } from "node:child_process";

// SPEC: 语音片段以 MP3（单声道 64 kbps）交付。两个网关（Pocket / Fish）都只产出 WAV，
//   52 秒约 2.5 MB；MP3 约 0.4 MB，所有浏览器都能播。
// INTENT: 在 Main 存储前转码，而不是改网关——两家网关共用一处，也不需要重启网关进程。
//   时长和计费在转码前已按 WAV 头算好，不受影响。
// INVARIANT: 转码失败（没有 ffmpeg、超时、非零退出）时原样交付 WAV，语音功能不因此不可用。
export async function encodeVoiceClipMp3(
  wav: Uint8Array,
  options: { ffmpegBin: string; timeoutMs?: number },
): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Uint8Array | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(options.ffmpegBin, [
      "-hide_banner", "-loglevel", "error",
      "-f", "wav", "-i", "pipe:0",
      "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "64k",
      "-f", "mp3", "pipe:1",
    ], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, options.timeoutMs ?? 30_000);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const body = Buffer.concat(chunks);
      finish(code === 0 && body.byteLength > 0 ? new Uint8Array(body) : null);
    });
    child.stdin.on("error", () => finish(null));
    child.stdin.end(Buffer.from(wav));
  });
}
