import { describe, expect, it } from "vitest";
import { VOICE_INPUT_MAX_UPLOAD_BYTES } from "@idream/shared/contracts";
import { readVoiceUpload } from "./upload";
function upload(bytes: Uint8Array, extra = false) {
  const form = new FormData();
  form.append("audio", new Blob([Uint8Array.from(bytes)], { type: "audio/webm" }), "clip.webm");
  if (extra) form.append("duration", "1");
  return new Request("http://localhost/upload", { method: "POST", body: form });
}
describe("voice recording stream boundary", () => {
  it("extracts one binary recording without trusting its filename or MIME", async () => {
    const audio = await readVoiceUpload(upload(new Uint8Array([1, 2, 3])));
    expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([1, 2, 3]);
  });
  it("rejects empty recordings and unexpected fields", async () => {
    await expect(readVoiceUpload(upload(new Uint8Array()))).rejects.toMatchObject({ code: "bad_request" });
    await expect(readVoiceUpload(upload(new Uint8Array([1]), true))).rejects.toMatchObject({ code: "bad_request" });
  });
  it("rejects actual audio beyond 8 MiB even without Content-Length", async () => {
    await expect(readVoiceUpload(upload(new Uint8Array(VOICE_INPUT_MAX_UPLOAD_BYTES + 1)))).rejects.toMatchObject({ code: "bad_request" });
  });
  it("stops an unbounded body before multipart parsing", async () => {
    let cancelled = false;
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
    const request = new Request("http://localhost/upload", { method: "POST", body: stream, headers: { "content-type": "multipart/form-data; boundary=x" }, duplex: "half" } as RequestInit);
    await expect(readVoiceUpload(request)).rejects.toMatchObject({ code: "bad_request" });
    expect(cancelled).toBe(true);
  });
});
