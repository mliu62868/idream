import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { parseLibraryResponse, parseWorkspaceMediaResponse } from "@/lib/public-api-contracts";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import * as remoteImage from "@/server/lib/safe-remote-image";
import { AGE_GATE_COOKIE_HEADER, api, createCharacter, createMedia, createUser, purgeTestData } from "@/server/test/helpers";
import { dispatchV1 } from "./service";

vi.mock("@/server/lib/safe-remote-image", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/lib/safe-remote-image")>(),
  readRemoteImage: vi.fn(),
}));

const prefix = "zt-remote-view-";
const owner = `${prefix}owner`;
const other = `${prefix}other`;
const characterId = `${prefix}character`;
const assetId = `${prefix}asset`;
const url = "https://images.example.org/flower.jpg";
let image: Buffer;

beforeAll(async () => {
  await purgeTestData(prefix);
  await createUser({ id: owner });
  await createUser({ id: other });
  await createMedia({ id: assetId, ownerId: owner, url, storageKey: null, contentType: "image/jpeg" });
  await createCharacter({ id: characterId, creatorId: owner, source: "user", visibility: "private", imageAssetId: assetId });
  await prisma.mediaAsset.update({ where: { id: assetId }, data: { characterId } });
  image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
});
beforeEach(() => {
  vi.mocked(remoteImage.readRemoteImage).mockReset();
  vi.mocked(remoteImage.readRemoteImage).mockResolvedValue({ bytes: image, contentType: "text/html" });
});
afterAll(async () => { await purgeTestData(prefix); await prisma.$disconnect(); });

it("projects external images into owned URLs accepted by created and gallery contracts", async () => {
  const expected = `/user-content/${Buffer.from(assetId).toString("base64url")}/content.jpg`;
  const created = await api("GET", "library/created", { userId: owner, ageGate: true });
  const gallery = await api("GET", "media", { userId: owner, ageGate: true });
  expect(created.status).toBe(200);
  expect(gallery.status).toBe(200);
  const character = parseLibraryResponse(created.json).items.find(item => item.id === characterId);
  const asset = parseWorkspaceMediaResponse(gallery.json).items.find(item => item.id === assetId);
  expect(character).toMatchObject({ image: expected, thumbnailUrl: expected });
  expect(asset).toMatchObject({ url: expected, thumbnailUrl: expected });
});

it("authorizes before fetching and returns decoded image bytes rather than redirecting to an external URL", async () => {
  const read = (userId: string, headers: Record<string, string> = {}) => dispatchV1(
    new Request(`http://localhost/api/v1/media/${assetId}/content`, { headers: { cookie: AGE_GATE_COOKIE_HEADER, "x-idream-user-id": userId, ...headers } }),
    ["media", assetId, "content"],
  );
  expect((await read(other)).status).toBe(403);
  expect(remoteImage.readRemoteImage).not.toHaveBeenCalled();
  const response = await read(owner);
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
  expect(remoteImage.readRemoteImage).toHaveBeenCalledWith(url);
  const partial = await read(owner, { range: "bytes=0-3" });
  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toBe(`bytes 0-3/${image.length}`);
  expect(Buffer.from(await partial.arrayBuffer())).toEqual(image.subarray(0, 4));
  vi.mocked(remoteImage.readRemoteImage).mockResolvedValue({ bytes: Buffer.from("<svg onload=alert(1)></svg>"), contentType: "image/png" });
  const invalid = await read(owner);
  expect(invalid.status).toBe(409);
  vi.mocked(remoteImage.readRemoteImage).mockResolvedValue({ bytes: Buffer.alloc(0), contentType: "image/png" });
  expect((await read(owner)).status).toBe(409);
  vi.mocked(remoteImage.readRemoteImage).mockRejectedValue(Errors.conflict("Private address"));
  const privateAddress = await read(owner);
  expect(privateAddress.status).toBe(409);
  expect(privateAddress.headers.get("location")).toBeNull();
});
