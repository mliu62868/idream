// SPEC: removes text and provenance chunks from a PNG without touching pixel data.
// INTENT: ComfyUI's SaveImage embeds the full prompt and workflow graph in tEXt
// chunks, including the user's text, our prompt templates and model file names.
// Keeping them there is useful on the runner host and wrong anywhere past it.
// Only PNG is handled because every backend emits PNG; removing metadata from JPEG
// or WebP would mean re-encoding pixels this pipeline otherwise preserves.
const METADATA_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < SIGNATURE.length || !SIGNATURE.every((byte, index) => bytes[index] === byte)) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [bytes.subarray(0, SIGNATURE.length)];
  let removed = false;
  let offset = SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const end = offset + 12 + view.getUint32(offset);
    if (end > bytes.length) break;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (METADATA_CHUNKS.has(type)) removed = true;
    else kept.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") return removed ? new Uint8Array(Buffer.concat(kept)) : bytes;
  }
  // No IEND: sanity validation rejects these, so never rewrite what can't be walked.
  return bytes;
}
