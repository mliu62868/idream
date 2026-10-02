import { Prisma } from "@prisma/client";
import { creatorStudioSummarySchema, type CreatorStudioItem } from "@/lib/creator-studio";
import { prisma } from "@/server/lib/db";
import { getAuthCtx, requireUser } from "@/server/lib/auth";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { readCurrentCharacterDraftDetails } from "./character-draft-details";
import { comicInclude, comicPublishable, comicPublicAuthor } from "./comic-authority";
import { packInclude, packCanOffer, packSnapshotSchema } from "./pack-authority";
import { activeCustomerUserWhere, directCharacterAudienceWhere, resolvePublicCharacterReleaseAssetPack } from "./public-content-audience";
import { creatorLevelProgram, readCreatorLevelDefinition } from "./creator-levels";

function inventory(rows: Array<{ status: string }>, publicAvailable: number) {
  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  return { total: rows.length, publicAvailable, byStatus };
}
function recentItem(row: { id: string; updatedAt: Date; status: string; visibility: string | null }, title: string, href: string): CreatorStudioItem {
  return { id: row.id, title, status: row.status, visibility: row.visibility as CreatorStudioItem["visibility"], updatedAt: row.updatedAt.toISOString(), href };
}

// Every count, current release, and published rule is read from one snapshot.
// This GET never calls publication preparation, submission, or any provider.
export async function creatorStudio(request: Request) {
  const actor = requireUser(await getAuthCtx(request));
  const summary = await prisma.$transaction(async tx => {
    const [{ asOf }] = await tx.$queryRaw<Array<{ asOf: Date }>>`SELECT CURRENT_TIMESTAMP AS "asOf"`;
    const owner = await tx.user.findFirst({ where: { id: actor.id, status: "active", deletedAt: null }, select: { id: true, role: true, dataClass: true } });
    if (!owner) throw Errors.unauthorized("Sign in to open Creator Studio");
    // The snapshot transaction owns one pg client; its queries must stay serial.
    const draftRows = await tx.characterDraft.findMany({ where: { ownerId: actor.id, editsCharacterId: null }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
    const characters = await tx.character.findMany({ where: { creatorId: actor.id, deletedAt: null }, select: { id: true, name: true, status: true, visibility: true, updatedAt: true, serving: { select: { state: true } } }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
    const candidates = await tx.character.findMany({ where: { AND: [{ creatorId: actor.id }, directCharacterAudienceWhere] }, select: { id: true, visibility: true, imageAssetId: true, serving: { select: { currentRelease: { select: { legacy: true, releasePlacementManifest: true } } } } } });
    const comics = await tx.comic.findMany({ where: { creatorId: actor.id }, include: comicInclude, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
    const packs = await tx.pack.findMany({ where: { creatorId: actor.id }, include: packInclude, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
    const followers = await tx.follow.count({ where: { followeeId: actor.id, followerId: { not: actor.id }, follower: { is: activeCustomerUserWhere } } });
    const grants = await tx.packGrant.findMany({ where: { userId: { not: actor.id }, user: { is: activeCustomerUserWhere }, release: { is: { pack: { is: { creatorId: actor.id } } } } }, select: { userId: true } });
    const definition = await readCreatorLevelDefinition(tx);
    const submitted = draftRows.length ? await tx.characterContentVersion.findMany({ where: { sourceType: "user", sourceId: { in: draftRows.map(row => row.id) } }, select: { sourceId: true } }) : [];
    const submittedIds = new Set(submitted.map(row => row.sourceId));
    const drafts = draftRows.filter(row => !submittedIds.has(row.id) && !readCurrentCharacterDraftDetails(row.advancedDetails).submittedCharacterId);
    const availableIds = new Set<string>();
    let publicCharacters = 0;
    for (const character of candidates) {
      const release = character.serving?.currentRelease;
      const readable = Boolean(release && (release.legacy || await resolvePublicCharacterReleaseAssetPack(tx, {
        characterId: character.id, imageAssetId: character.imageAssetId, releasePlacementManifest: release.releasePlacementManifest,
      })));
      if (readable) {
        availableIds.add(character.id);
        if (character.visibility === "public") publicCharacters++;
      }
    }
    const characterItems = characters.map(row => {
      const status = ["rejected", "removed"].includes(row.status) ? row.status
        : row.visibility !== "private" && row.serving?.state === "paused" ? "paused"
        : row.status === "archived" ? "archived"
        : row.visibility === "private" ? "private"
        : availableIds.has(row.id) ? (row.visibility === "public" ? "available" : "available_by_link")
        : "awaiting_publication";
      return { ...row, status };
    });
    const publicComics = comics.filter(row => row.status === "published" && row.visibility === "public" && comicPublicAuthor(row) && comicPublishable(row)).length;
    const publicPacks = packs.filter(row => row.visibility === "public" && packCanOffer(row, asOf) && packSnapshotSchema.safeParse(row.currentRelease?.manifest).success).length;
    const paused = characterItems.filter(row => row.visibility === "public" && row.status === "paused").length;
    return creatorStudioSummarySchema.parse({
      schemaVersion: 1, viewerId: actor.id, asOf: asOf.toISOString(),
      counts: { drafts: drafts.length, characters: characters.length, publicCharacters,
        comics: inventory(comics, publicComics), packs: inventory(packs, publicPacks),
        followers, packClaims: grants.length, packClaimants: new Set(grants.map(row => row.userId)).size },
      publicCharacterQualification: { available: publicCharacters, paused, awaiting: characterItems.filter(row => row.visibility === "public" && row.status === "awaiting_publication").length },
      program: creatorLevelProgram(definition, { eligible: owner.role === "user" && owner.dataClass === "customer", publicWorks: publicCharacters + publicComics + publicPacks, followers }),
      recent: {
        drafts: drafts.map(row => recentItem({ ...row, status: "draft", visibility: null }, row.name ?? "Untitled draft", `/create?draft=${encodeURIComponent(row.id)}`)),
        characters: characterItems.slice(0, 6).map(row => recentItem(row, row.name, `/create?edit=${encodeURIComponent(row.id)}`)),
        comics: comics.slice(0, 6).map(row => recentItem(row, row.title, `/creator-studio/comics/${encodeURIComponent(row.id)}`)),
        packs: packs.slice(0, 6).map(row => recentItem(row, row.title, `/packs/${encodeURIComponent(row.id)}${row.status === "blocked" ? "" : "/edit"}`)),
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  const response = ok(summary);
  response.headers.set("cache-control", "private, no-store");
  return response;
}
