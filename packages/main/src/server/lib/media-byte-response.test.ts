import { describe, expect, it } from "vitest";
import { mediaByteResponse } from "./media-byte-response";

const headers = {
  "cache-control": "private, no-store, max-age=0",
  "content-type": "audio/mpeg",
  "x-content-type-options": "nosniff",
  vary: "Cookie, Authorization",
};
const bytes = new Uint8Array([99, 1, 2, 3, 4, 5, 6, 7, 8, 88]).subarray(1, 9);

function request(range?: string) {
  return new Request("http://localhost/api/v1/packs/pack/releases/release/items/voice/content", {
    headers: range ? { range } : undefined,
  });
}

describe("verified media byte responses", () => {
  it("delivers the complete view with a known length without leaking its backing buffer", async () => {
    const response = mediaByteResponse(request(), bytes, headers);
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("8");
    expect(response.headers.get("content-range")).toBeNull();
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it.each([
    { range: "bytes=2-5", contentRange: "bytes 2-5/8", expected: [3, 4, 5, 6] },
    { range: "bytes=3-", contentRange: "bytes 3-7/8", expected: [4, 5, 6, 7, 8] },
    { range: "bytes=-3", contentRange: "bytes 5-7/8", expected: [6, 7, 8] },
    { range: "bytes=5-99", contentRange: "bytes 5-7/8", expected: [6, 7, 8] },
    { range: "bytes=-99", contentRange: "bytes 0-7/8", expected: [1, 2, 3, 4, 5, 6, 7, 8] },
  ])("returns the exact authorized slice for $range", async ({ range, contentRange, expected }) => {
    const response = mediaByteResponse(request(range), bytes, headers);
    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(expected.length));
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(expected);
  });

  it.each([
    "bytes=8-", "bytes=4-3", "bytes=-0", "bytes=-", "bytes=1-2,4-5",
    "items=0-1", "bytes=9007199254740992-", "bytes=0-9007199254740992",
  ])("rejects %s without exposing any bytes", async (range) => {
    const response = mediaByteResponse(request(range), bytes, headers);
    expect(response.status).toBe(416);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes */8");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("preserves private download headers without mutating the caller's headers", async () => {
    const original = new Headers({ ...headers, "content-disposition": 'attachment; filename="pack-release-voice.mp3"' });
    const response = mediaByteResponse(request("bytes=2-5"), bytes, original);
    for (const [name, value] of original) expect(response.headers.get(name)).toBe(value);
    expect(original.get("accept-ranges")).toBeNull();
    expect(original.get("content-length")).toBeNull();
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([3, 4, 5, 6]);
  });

  it("delivers an empty complete body but rejects a range against it", async () => {
    const full = mediaByteResponse(request(), new Uint8Array(), headers);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe("0");
    expect((await full.arrayBuffer()).byteLength).toBe(0);
    const partial = mediaByteResponse(request("bytes=0-"), new Uint8Array(), headers);
    expect(partial.status).toBe(416);
    expect(partial.headers.get("content-range")).toBe("bytes */0");
    expect((await partial.arrayBuffer()).byteLength).toBe(0);
  });
});
