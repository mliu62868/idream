// INVARIANT: Callers establish access and verify complete stored bytes before
// constructing the response; a Range header never changes those checks.
export function mediaByteResponse(
  request: Request,
  body: Uint8Array,
  headerInit: HeadersInit,
) {
  const headers = new Headers(headerInit);
  headers.set("accept-ranges", "bytes");
  const range = parseByteRange(request.headers.get("range"), body.byteLength);
  if (range === "invalid") {
    headers.set("content-range", `bytes */${body.byteLength}`);
    return new Response(null, { status: 416, headers });
  }

  if (range) {
    const chunk = body.subarray(range.start, range.end + 1);
    headers.set("content-length", String(chunk.byteLength));
    headers.set("content-range", `bytes ${range.start}-${range.end}/${body.byteLength}`);
    return new Response(arrayBufferBody(chunk), { status: 206, headers });
  }

  headers.set("content-length", String(body.byteLength));
  return new Response(arrayBufferBody(body), { headers });
}

function arrayBufferBody(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function parseByteRange(header: string | null, size: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return "invalid";
  const [, rawStart, rawEnd] = match;

  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return "invalid";
  }

  return { start, end: Math.min(end, size - 1) };
}
