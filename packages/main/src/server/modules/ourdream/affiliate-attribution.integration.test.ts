import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { api, cookieHeader, createCharacter, createUser, expectError, expectOk, publishCharacterForPublicAudience, purgeTestData } from "@/server/test/helpers";
import { dispatchV1 } from "./service";
import { GET as adminAttribution } from "@/app/api/v2/admin/affiliate/applications/[id]/attribution/route";
import { adminV2Route } from "@/server/test/admin-v2-route-client";

const prefix = "zt-affiliate-attribution-", partner = `${prefix}partner`, other = `${prefix}other`;
const code = `${prefix}code`, terms = "2026-10-01T00:00:00.000Z", signedUp: string[] = [], keys: string[] = [];
const administrator = `${prefix}administrator`;
beforeAll(async () => {
  await createUser({ id: partner, dataClass: "customer" }); await createUser({ id: other, dataClass: "customer" });
  await createUser({ id: administrator, role: "admin", dataClass: "internal" });
  await prisma.affiliateApplication.create({ data: { id: code, userId: partner, status: "approved", termsVersion: terms, channels: ["https://example.invalid/channel"], reviewedAt: new Date() } });
});
afterAll(async () => { for (const key of keys) await providers.blob.delete({ key }); await prisma.user.deleteMany({ where: { id: { in: signedUp } } }); await purgeTestData(prefix); });
// Each case owns its visits; a relative expired date can overlap a fixed paging date.
afterEach(async () => { await prisma.affiliateClick.deleteMany({ where: { affiliateUserId: partner } }); });
const dashboard = (query: Record<string, string | number> = {}) => api("GET", "affiliate/dashboard", { userId: partner, ageGate: true, query });

describe("AF-02 auditable signup attribution and public promotion materials", () => {
  it("freezes the click rule and terms, binds one real signup, and reports current account revocation without rewriting history", async () => {
    const clicked = await api("POST", "affiliate/click", { headers: { "x-forwarded-for": "203.0.113.221", "user-agent": `${prefix}signup` }, body: { code, landingPath: "/?private=must-not-be-shared" } });
    expectOk(clicked, 201);
    const original = await prisma.affiliateClick.findUniqueOrThrow({ where: { id: clicked.data.id } });
    expect(original).toMatchObject({ attributionVersion: "affiliate-signup-v1", attributionWindowDays: 30, termsVersion: terms, landingPath: "/" });
    const signup = await api("POST", "auth/signup", { cookie: cookieHeader(clicked.setCookies), body: { email: `${prefix}${randomUUID()}@customer.invalid`, password: "Affiliate-attribution-1001!", name: "Referred customer" } }); expectOk(signup);
    const userId = signup.data.user.id as string; signedUp.push(userId);
    const converted = await prisma.affiliateClick.findUniqueOrThrow({ where: { id: original.id } });
    expect(converted).toMatchObject({ convertedUserId: userId }); expect(converted.convertedAt).not.toBeNull();
    const valid = await dashboard(); expectOk(valid);
    expect(valid.data.attribution.items.find((item: { id: string }) => item.id === original.id)).toMatchObject({ state: "valid", attributionVersion: "affiliate-signup-v1", termsVersion: terms });
    expect(JSON.stringify(valid.data)).not.toContain(userId); expect(JSON.stringify(valid.data)).not.toContain("visitorKey");
    const readable = await adminV2Route(adminAttribution, { method: "GET", path: `affiliate/applications/${code}/attribution`, params: { id: code }, userId: administrator }); expectOk(readable);
    expect(readable.data.items.find((item: { id: string }) => item.id === original.id)).toMatchObject({ convertedUserId: userId, state: "valid", attributionVersion: "affiliate-signup-v1", termsVersion: terms });
    expectError(await adminV2Route(adminAttribution, { method: "GET", path: `affiliate/applications/${code}/attribution`, params: { id: code }, userId: partner }), 403);
    await prisma.user.update({ where: { id: userId }, data: { status: "suspended" } });
    expect((await dashboard()).data.attribution.items.find((item: { id: string }) => item.id === original.id)).toMatchObject({ state: "revoked", reason: "account_inactive" });
    await prisma.user.delete({ where: { id: userId } });
    expect((await dashboard()).data.attribution.items.find((item: { id: string }) => item.id === original.id)).toMatchObject({ state: "revoked", reason: "account_removed" });
    expect(await prisma.affiliateClick.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ convertedAt: converted.convertedAt, convertedUserId: userId, attributionVersion: "affiliate-signup-v1", termsVersion: terms });
  });
  it("keeps historical conversions unverified and separates awaiting signup from expired visits", async () => {
    const now = new Date();
    await prisma.affiliateClick.createMany({ data: [
      { id: `${prefix}legacy`, affiliateUserId: partner, code, visitorKey: `${prefix}legacy`, landingPath: "/", convertedAt: now, createdAt: now },
      { id: `${prefix}waiting`, affiliateUserId: partner, code, visitorKey: `${prefix}waiting`, landingPath: "/", createdAt: now },
      { id: `${prefix}expired`, affiliateUserId: partner, code, visitorKey: `${prefix}expired`, landingPath: "/", createdAt: new Date(now.getTime() - 31 * 86_400_000) },
    ] });
    const result = await dashboard(); expectOk(result);
    expect(result.data.attribution.items).toContainEqual(expect.objectContaining({ id: `${prefix}legacy`, state: "pending", reason: "legacy_unverified", attributionVersion: null, termsVersion: null }));
    expect(result.data.attribution.items).toContainEqual(expect.objectContaining({ id: `${prefix}waiting`, state: "awaiting_signup" }));
    expect(result.data.attribution.items).toContainEqual(expect.objectContaining({ id: `${prefix}expired`, state: "expired" }));
  });
  it("paginates stable tied visit dates and binds cursors to the owner and UTC date filter", async () => {
    const createdAt = new Date("2026-09-01T12:00:00.000Z"), ids = Array.from({ length: 21 }, (_, index) => `${prefix}page-${String(index).padStart(2, "0")}`);
    await prisma.affiliateClick.createMany({ data: ids.map(id => ({ id, affiliateUserId: partner, code, visitorKey: id, landingPath: "/", createdAt })) });
    const query = { from: "2026-09-01", to: "2026-09-01", limit: 10 };
    const first = await dashboard(query); expectOk(first); expect(first.data.attribution.items.map((item: { id: string }) => item.id)).toEqual([...ids].reverse().slice(0, 10));
    const cursor = first.data.attribution.pageInfo.endCursor as string;
    // Deleting the cursor row does not skip the next row; paging uses immutable date and ID values.
    await prisma.affiliateClick.delete({ where: { id: first.data.attribution.items.at(-1).id } });
    const second = await dashboard({ ...query, cursor }); expectOk(second); expect(second.data.attribution.items.map((item: { id: string }) => item.id)).toEqual([...ids].reverse().slice(10, 20));
    expectError(await dashboard({ ...query, from: "2026-09-02", to: "2026-09-02", cursor }), 400);
    expectError(await api("GET", "affiliate/dashboard", { userId: other, query: { ...query, cursor } }), 400);
    expectError(await dashboard({ from: "2026-09-02", to: "2026-09-01" }), 400);
  });
  it("offers only approved partners qualified public Character materials through the existing download authority", async () => {
    const publicCharacter = `${prefix}public-character`, privateCharacter = `${prefix}private-character`;
    await createCharacter({ id: publicCharacter, creatorId: partner, name: "000 Affiliate material" }); await createCharacter({ id: privateCharacter, creatorId: partner, visibility: "private" });
    const published = await publishCharacterForPublicAudience({ characterId: publicCharacter, ownerId: partner });
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: published.assetId } });
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); keys.push(asset.storageKey!);
    await providers.blob.putPrivate({ key: asset.storageKey!, body: bytes, contentType: asset.contentType! });
    const result = await dashboard(); expectOk(result);
    const material = result.data.materials.find((item: { characterId: string }) => item.characterId === publicCharacter);
    expect(material).toMatchObject({ assetId: asset.id, linkPath: `/?aff=${code}`, downloadPath: `/api/v1/media/${encodeURIComponent(asset.id)}/content?download=1` });
    expect(result.data.materials.some((item: { characterId: string }) => item.characterId === privateCharacter)).toBe(false);
    const path = material.downloadPath as string;
    const download = await dispatchV1(new Request(`http://localhost${path}`, { headers: { "x-idream-user-id": partner } }), ["media", asset.id, "content"]);
    expect(download.status).toBe(200); expect(download.headers.get("content-disposition")).toContain("attachment"); expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    await prisma.affiliateApplication.update({ where: { id: code }, data: { status: "rejected" } });
    expect((await dashboard()).data).toMatchObject({ linkPath: null, materials: [] });
    expectError(await api("POST", "affiliate/click", { body: { code } }), 404);
  });
});
