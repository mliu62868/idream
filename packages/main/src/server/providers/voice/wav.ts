// Both resident gateways emit uncompressed PCM WAV. Admit that exact contract
// before persistence or minute billing; a MIME header or text-length estimate
// cannot prove that bytes are playable or establish their duration.
export function pcmWavDurationMs(body: Uint8Array): number | null {
  if (body.byteLength < 44 || ascii(body, 0, 4) !== "RIFF" || ascii(body, 8, 4) !== "WAVE") return null;
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (view.getUint32(4, true) + 8 !== body.byteLength) return null;
  let offset = 12;
  let sampleRate = 0;
  let blockAlign = 0;
  let dataSize: number | null = null;
  while (offset < body.byteLength) {
    if (offset + 8 > body.byteLength) return null;
    const chunk = ascii(body, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > body.byteLength) return null;
    if (chunk === "fmt ") {
      if (sampleRate || size < 16 || view.getUint16(start, true) !== 1) return null;
      const channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      const byteRate = view.getUint32(start + 8, true);
      blockAlign = view.getUint16(start + 12, true);
      const bits = view.getUint16(start + 14, true);
      if (!channels || !sampleRate || ![8, 16, 24, 32].includes(bits) ||
        blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign) return null;
    } else if (chunk === "data") {
      if (dataSize !== null) return null;
      dataSize = size;
    }
    offset = end + size % 2;
  }
  if (offset !== body.byteLength || !sampleRate || !blockAlign || !dataSize || dataSize % blockAlign) return null;
  return Math.max(1, Math.round(dataSize / blockAlign / sampleRate * 1_000));
}

function ascii(body: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...body.subarray(offset, offset + length));
}
