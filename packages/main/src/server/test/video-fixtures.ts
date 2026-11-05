import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Actual, decodable local media. These fixtures exercise packaging and the
// delivery transport; they are never evidence of model-generation qualification.
export async function videoFixture(input: { width?: number; height?: number; frames?: number; fps?: number; color?: string; audio?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "idream-video-fixture-"));
  try {
    const output = join(directory, "fixture.mp4"), fps = input.fps ?? 24, frames = input.frames ?? 13;
    const args = ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${input.color ?? "red"}:s=${input.width ?? 64}x${input.height ?? 96}:r=${fps}`];
    if (input.audio !== false) args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000");
    args.push("-frames:v", String(frames), "-t", String(frames / fps), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
    if (input.audio !== false) args.push("-c:a", "aac", "-ar", "48000", "-ac", "2");
    args.push(output);
    await run("ffmpeg", args, { timeout: 30_000 });
    return new Uint8Array(await readFile(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function narrationFixture(seconds: number, frequency = 880) {
  const directory = await mkdtemp(join(tmpdir(), "idream-narration-fixture-"));
  try {
    const output = join(directory, "fixture.wav");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=24000`, "-t", String(seconds), "-c:a", "pcm_s16le", output], { timeout: 30_000 });
    return new Uint8Array(await readFile(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// composeVideoScenes takes paths. Left for the OS tmp cleaner: each fixture is tiny and
// a test can hand these to a mocked composer whose lifetime outlives its own scope.
export async function sceneFiles(scenes: ReadonlyArray<{ video: Uint8Array; narration?: Uint8Array }>) {
  const directory = await mkdtemp(join(tmpdir(), "idream-video-scene-files-"));
  return Promise.all(scenes.map(async (scene, index) => {
    const videoPath = join(directory, `scene-${index}.mp4`);
    await writeFile(videoPath, scene.video);
    if (!scene.narration) return { videoPath };
    const narrationPath = join(directory, `narration-${index}.wav`);
    await writeFile(narrationPath, scene.narration);
    return { videoPath, narrationPath };
  }));
}
