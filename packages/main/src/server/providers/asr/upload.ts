import { VOICE_INPUT_MAX_UPLOAD_BYTES } from "@idream/shared/contracts";
import { Errors } from "@/server/lib/errors";

// Count the actual stream, including a bounded multipart envelope. Content-Length
// and browser-provided MIME/duration are not admission authority.
export async function readVoiceUpload(request: Request): Promise<Blob> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(type)) throw Errors.badRequest("A multipart audio recording is required");
  const maxBody = VOICE_INPUT_MAX_UPLOAD_BYTES + 16 * 1024;
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBody) throw Errors.badRequest("Recording exceeds the upload limit");
  if (!request.body) throw Errors.badRequest("An audio recording is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(Errors.badRequest("Recording upload timed out")); }, 20_000);
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), timeout]);
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBody) throw Errors.badRequest("Recording exceeds the upload limit");
      chunks.push(Uint8Array.from(item.value));
    }
    const form = await new Response(new Blob(chunks), { headers: { "content-type": type } }).formData();
    const entries = [...form.entries()];
    const audio = form.get("audio");
    if (entries.length !== 1 || entries[0][0] !== "audio" || !(audio instanceof Blob)) throw Errors.badRequest("Exactly one audio file is required");
    if (!audio.size || audio.size > VOICE_INPUT_MAX_UPLOAD_BYTES) throw Errors.badRequest("Recording is empty or exceeds the upload limit");
    return audio;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof Error && error.name === "AppError") throw error;
    throw Errors.badRequest("Invalid recording upload");
  } finally { if (timer) clearTimeout(timer); reader.releaseLock(); }
}
