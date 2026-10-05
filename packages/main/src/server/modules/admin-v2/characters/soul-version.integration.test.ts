import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCharacterSoulSnapshot } from "@idream/shared";
import { characterPortfolioQuerySchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { POST as createSoulVersionRoute } from "@/app/api/v2/admin/characters/[id]/soul/versions/route";
import { createCharacterSoulVersion } from "./soul-version";
import { previewSnapshot } from "./workspace-preview";
import { listCharacterPortfolioData } from "./portfolio";
import { canonicalSha256 } from "../shared/canonical-json";

describe("Character Soul version authority", () => {
  const suffix = randomUUID();
  const characterId = `soul-version-character-${suffix}`;
  const projectId = `soul-version-project-${suffix}`;
  const contentId = `soul-version-content-${suffix}`;
  const revisionId = `soul-version-revision-${suffix}`;
  const actorId = `soul-version-actor-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@example.test`,
        role: "admin",
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Legacy Mara",
        age: 28,
        gender: "female",
        description: "Mutable projection must not become Soul input.",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        activeKey: `soul-version:${suffix}`,
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `legacy-soul-version-${suffix}`,
        personaSnapshot: {
          name: "Pinned Mara",
          age: 28,
          gender: "female",
          description: "Pinned legacy promise.",
          relationship: "late-night confidante",
          personality: "Measured and observant.",
          systemPrompt: "PINNED LEGACY PROMPT",
        },
        openingSnapshot: { firstMessage: "Pinned opening." },
        appearanceSnapshot: {
          style: "realistic",
          structured: { sourceImage: "/legacy-mara.webp" },
        },
        sourceType: "soul_version_test",
      },
    });
    await prisma.characterRevision.create({
      data: {
        id: revisionId,
        projectId,
        revision: 1,
        characterContentVersionId: contentId,
        projectSnapshot: {},
      },
    });
  });

  afterAll(async () => {
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId, commandType: "character.soul.version.create" },
    });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: projectId } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: projectId } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: projectId } });
    await prisma.characterRevision.deleteMany({ where: { projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("creates only a new immutable Soul/opening version and preserves appearance bytes", async () => {
    const created = await createCharacterSoulVersion({
      characterId,
      expectedProjectVersion: 1,
      expectedContentVersionId: contentId,
      actor: { id: actorId, role: "admin" },
      persona: {
        name: "Pinned Mara",
        age: 28,
        gender: "female",
        characterPromise: "A precise place to put the day down.",
        detailsMarkdown: "Measured, observant, and gently challenging. Warm and concise. A former night-shift radio host.",
        firstMessage: "What followed you home tonight?",
      },
      requestId: `soul-version-request-${suffix}`,
    });

    expect(created).toMatchObject({
      characterId,
      projectId,
      projectVersion: 2,
      contentVersion: 2,
      revision: 2,
    });
    const versions = await prisma.characterContentVersion.findMany({
      where: { characterId },
      orderBy: { version: "asc" },
    });
    expect(versions).toHaveLength(2);
    expect(versions[1]?.appearanceSnapshot).toEqual(versions[0]?.appearanceSnapshot);
    expect(versions[1]?.openingSnapshot).toEqual({
      firstMessage: "What followed you home tonight?",
    });
    const loaded = loadCharacterSoulSnapshot(versions[1]?.personaSnapshot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("created Soul must load through runtime authority");
    expect(loaded.snapshot.soul.characterPromise).toBe(
      "A precise place to put the day down.",
    );
    expect(await prisma.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({
      name: "Legacy Mara",
      description: "Mutable projection must not become Soul input.",
    });
    expect(await prisma.adminAuditLog.count({
      where: { targetId: projectId, action: "character.soul.version_created" },
    })).toBe(1);
  });

  it("replays the HTTP mutation by idempotency key without creating a third copy", async () => {
    const current = await prisma.characterContentVersion.findFirstOrThrow({
      where: { characterId },
      orderBy: { version: "desc" },
    });
    const body = {
      entityVersion: 2,
      expectedContentVersionId: current.id,
      persona: {
        name: "Pinned Mara",
        age: 28,
        gender: "female",
        characterPromise: "A precise place to put the day down.",
        detailsMarkdown: "Measured, observant, and gently challenging. Warm, concise, and newly candid. A former night-shift radio host.",
        firstMessage: "What followed you home tonight?",
      },
    };
    const key = `soul-version-http-${suffix}`;
    const request = () => new Request(
      `http://localhost/api/v2/admin/characters/${characterId}/soul/versions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          "if-match": '"2"',
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify(body),
      },
    );

    const created = await createSoulVersionRoute(request(), {
      params: Promise.resolve({ id: characterId }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      data: { projectVersion: 3, contentVersion: 3, replayed: false },
    });
    const replay = await createSoulVersionRoute(request(), {
      params: Promise.resolve({ id: characterId }),
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({
      data: { projectVersion: 3, contentVersion: 3, replayed: true },
    });
    expect(await prisma.characterContentVersion.count({ where: { characterId } })).toBe(3);
  });

  it("saves an edited visual direction with the persona and previews the draft, not the live row", async () => {
    const current = await prisma.characterContentVersion.findFirstOrThrow({
      where: { characterId },
      orderBy: { version: "desc" },
    });
    const response = await createSoulVersionRoute(new Request(
      `http://localhost/api/v2/admin/characters/${characterId}/soul/versions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `soul-version-visual-${suffix}`,
          "if-match": '"3"',
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify({
          entityVersion: 3,
          expectedContentVersionId: current.id,
          persona: {
            name: "Renamed Mara",
            age: 28,
            gender: "female",
            characterPromise: "A renamed draft promise.",
            detailsMarkdown: "",
            firstMessage: "What followed you home tonight?",
          },
          visualDirection: {
            identityAnchor: "Composed late-night radio host",
            stableTraits: ["Dark wavy hair", "Warm brown eyes"],
            style: "anime",
            referenceDirection: "Low-key tungsten portraiture",
          },
        }),
      },
    ), { params: Promise.resolve({ id: characterId }) });
    expect(response.status).toBe(201);

    const saved = await prisma.characterContentVersion.findFirstOrThrow({
      where: { characterId },
      orderBy: { version: "desc" },
    });
    // The legacy structured source image survives; only the four direction keys change.
    expect(saved.appearanceSnapshot).toEqual({
      style: "anime",
      structured: { sourceImage: "/legacy-mara.webp" },
      identityAnchor: "Composed late-night radio host",
      stableTraits: ["Dark wavy hair", "Warm brown eyes"],
      referenceDirection: "Low-key tungsten portraiture",
    });
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { targetId: projectId, action: "character.soul.version_created" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.reason).toBeNull();

    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const missing = { assetId: null, imageUrl: null, status: "missing" as const };
    const draft = previewSnapshot({
      character,
      content: saved,
      releaseId: null,
      servingVersion: null,
      assetPack: { character_cover: missing, character_hero: missing, character_chat: missing },
      label: "Draft Preview",
    });
    expect(draft).toMatchObject({
      name: "Renamed Mara",
      description: "A renamed draft promise.",
    });
  });

  it("shows and searches the current draft name without matching superseded draft names", async () => {
    const current = await prisma.characterContentVersion.findFirstOrThrow({ where: { characterId }, orderBy: { version: "desc" } });
    const loaded = loadCharacterSoulSnapshot(current.personaSnapshot);
    if (!loaded.ok) throw new Error("fixture must have a valid Soul");
    const project = await prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } });
    const draftName = `Draft Mara ${suffix}`;
    await createCharacterSoulVersion({
      characterId, expectedProjectVersion: project.version, expectedContentVersionId: current.id,
      actor: { id: actorId, role: "admin" },
      persona: { ...loaded.snapshot.soul, name: draftName, firstMessage: "What followed you home tonight?" },
      requestId: `draft-name-${suffix}`,
    });
    const scoped = { authorizedCharacterIds: [characterId] };
    const list = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({ includePerformance: false }), scoped);
    expect(list.items[0]?.name).toBe(draftName);
    const found = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({ search: draftName, includePerformance: false }), scoped);
    expect(found.items.map((item) => item.characterId)).toEqual([characterId]);
    const historical = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({ search: "Renamed Mara", includePerformance: false }), scoped);
    expect(historical.items).toEqual([]);
  });

  it("restores earlier content as a new immutable version and replays it exactly once", async () => {
    const baseline = await prisma.characterContentVersion.findFirstOrThrow({ where: { characterId }, orderBy: { version: "desc" } });
    const loaded = loadCharacterSoulSnapshot(baseline.personaSnapshot);
    if (!loaded.ok) throw new Error("fixture must have a valid Soul");
    const project = await prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } });
    const original = { ...loaded.snapshot.soul, firstMessage: "What followed you home tonight?" };
    const edited = await createCharacterSoulVersion({
      characterId, expectedProjectVersion: project.version, expectedContentVersionId: baseline.id,
      actor: { id: actorId, role: "admin" }, persona: { ...original, name: "Temporary name" }, requestId: `temporary-name-${suffix}`,
    });
    const request = () => new Request(`http://localhost/api/v2/admin/characters/${characterId}/soul/versions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `restore-soul-${suffix}`, "if-match": `"${edited.projectVersion}"`, "x-idream-user-id": actorId, "x-idream-role": "admin" },
      body: JSON.stringify({ entityVersion: edited.projectVersion, expectedContentVersionId: edited.contentVersionId, persona: original }),
    });
    const restored = await createSoulVersionRoute(request(), { params: Promise.resolve({ id: characterId }) });
    expect(restored.status).toBe(201);
    const result = await restored.json();
    expect(result.data).toMatchObject({ contentVersion: baseline.version + 2, projectVersion: project.version + 2, replayed: false });
    const saved = await prisma.characterContentVersion.findUniqueOrThrow({ where: { id: result.data.contentVersionId } });
    expect(saved.contentHash).toBe(baseline.contentHash);
    expect(saved.personaSnapshot).toEqual(baseline.personaSnapshot);
    expect(saved.appearanceSnapshot).toEqual(baseline.appearanceSnapshot);
    expect(await prisma.characterContentVersion.findUniqueOrThrow({ where: { id: baseline.id } })).toEqual(baseline);
    const replay = await createSoulVersionRoute(request(), { params: Promise.resolve({ id: characterId }) });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ data: { contentVersionId: saved.id, replayed: true } });
    expect(await prisma.characterServing.findUnique({ where: { characterId } })).toBeNull();
    expect((await prisma.character.findUniqueOrThrow({ where: { id: characterId } })).name).toBe("Legacy Mara");
  });

  it("treats an unchanged save as a no-op and rejects a stale editor explicitly", async () => {
    const current = await prisma.characterContentVersion.findFirstOrThrow({ where: { characterId }, orderBy: { version: "desc" } });
    const loaded = loadCharacterSoulSnapshot(current.personaSnapshot);
    if (!loaded.ok) throw new Error("fixture must have a valid Soul");
    const project = await prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } });
    const revision = await prisma.characterRevision.findFirstOrThrow({ where: { projectId }, orderBy: { revision: "desc" } });
    const auditCount = await prisma.adminAuditLog.count({ where: { targetId: projectId } });
    const outboxCount = await prisma.mainOutboxEvent.count({ where: { aggregateId: projectId } });
    const input = {
      characterId, expectedProjectVersion: project.version, expectedContentVersionId: current.id,
      actor: { id: actorId, role: "admin" },
      persona: { ...loaded.snapshot.soul, firstMessage: "What followed you home tonight?" },
      requestId: `unchanged-soul-${suffix}`,
    } satisfies Parameters<typeof createCharacterSoulVersion>[0];
    expect(await createCharacterSoulVersion(input)).toMatchObject({
      projectVersion: project.version, contentVersionId: current.id, contentVersion: current.version,
      revisionId: revision.id, revision: revision.revision,
    });
    expect(await prisma.characterContentVersion.count({ where: { characterId } })).toBe(current.version);
    expect(await prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } })).toEqual(project);
    expect(await prisma.adminAuditLog.count({ where: { targetId: projectId } })).toBe(auditCount);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: projectId } })).toBe(outboxCount);
    await expect(createCharacterSoulVersion({ ...input, expectedProjectVersion: project.version - 1 })).rejects.toMatchObject({
      code: "conflict", details: { blocker: "version_mismatch", projectVersion: project.version, contentVersionId: current.id },
    });
  });

  it("rejects a Soul edit while a candidate Release pins the draft, like image placement does", async () => {
    const current = await prisma.characterContentVersion.findFirstOrThrow({ where: { characterId }, orderBy: { version: "desc" } });
    const loaded = loadCharacterSoulSnapshot(current.personaSnapshot);
    if (!loaded.ok) throw new Error("fixture must have a valid Soul");
    const project = await prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } });
    const revision = await prisma.characterRevision.findFirstOrThrow({ where: { projectId }, orderBy: { revision: "desc" } });
    const candidate = await prisma.characterRelease.create({ data: {
      projectId, revisionId: revision.id, characterContentVersionId: current.id,
      generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: `soul-version-candidate-${suffix}`,
    } });
    try {
      await expect(createCharacterSoulVersion({
        characterId, expectedProjectVersion: project.version, expectedContentVersionId: current.id,
        actor: { id: actorId, role: "admin" },
        persona: { ...loaded.snapshot.soul, firstMessage: "Pinned opening.", characterPromise: "Edited behind a pending candidate." },
        requestId: `candidate-soul-${suffix}`,
      })).rejects.toMatchObject({
        code: "conflict",
        details: { releaseId: candidate.id, status: "approved", deepLink: `/admin/characters/${characterId}?tab=release` },
      });
      expect(await prisma.characterContentVersion.count({ where: { characterId } })).toBe(current.version);
    } finally {
      await prisma.characterRelease.delete({ where: { id: candidate.id } });
    }
  });

  it("excludes removed characters before counting and paginating", async () => {
    const baseline = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({ includePerformance: false }));
    const removedId = `removed-portfolio-${suffix}`;
    const removedProjectId = `removed-project-${suffix}`;
    await prisma.character.create({ data: { id: removedId, name: "Removed role", age: 25, description: "Deleted fixture", source: "official", deletedAt: new Date(), appearance: {}, advancedDetails: {} } });
    await prisma.characterProject.create({ data: { id: removedProjectId, characterId: removedId, activeKey: removedProjectId } });
    try {
      const result = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({ includePerformance: false }));
      expect(result.pageInfo.totalCount).toBe(baseline.pageInfo.totalCount);
      expect(result.items.some((item) => item.characterId === removedId)).toBe(false);
    } finally {
      await prisma.characterProject.delete({ where: { id: removedProjectId } });
      await prisma.character.delete({ where: { id: removedId } });
    }
  });

  it("uses a verified schema v1 draft name and promise instead of the live projection", async () => {
    const historicalId = `historical-portfolio-${suffix}`;
    const historicalProjectId = `historical-project-${suffix}`;
    const soul = {
      identity: { name: "Historical Mira", age: 29, gender: "female", relationshipArchetype: "trusted companion", characterPromise: "A precise observatory keeper." },
      innerLife: { personality: "Grounded and curious.", values: ["honesty"], wants: [], fears: [], contradictions: [], backstory: "" },
      voice: { tone: "Warm and direct.", cadence: "", vocabulary: [], habits: [], avoid: [] },
      interaction: { initiative: "", curiosity: "", pacing: "", affection: "", conflict: "", repair: "" },
      canon: { facts: ["The observatory windows are blue."], unknowns: [] },
      dialogue: { positive: [], negative: [] },
    };
    const compiled = { compilerVersion: "character-soul-1", systemPrompt: "Historical observatory keeper prompt." };
    const personaSnapshot = { schemaVersion: 1, soul, compiled: { ...compiled, fingerprint: canonicalSha256({ soul, ...compiled }), estimatedTokens: 10 } };
    const loaded = loadCharacterSoulSnapshot(personaSnapshot);
    expect(loaded.ok).toBe(true);
    await prisma.character.create({ data: { id: historicalId, name: "Live Mira", age: 29, description: "An older live promise.", source: "official", appearance: {}, advancedDetails: {} } });
    try {
      await prisma.characterProject.create({ data: { id: historicalProjectId, characterId: historicalId, activeKey: historicalProjectId } });
      await prisma.characterContentVersion.create({ data: { characterId: historicalId, version: 1, contentHash: canonicalSha256(personaSnapshot), personaSnapshot, openingSnapshot: { firstMessage: "Look up; the sky changed." }, appearanceSnapshot: {}, sourceType: "historical_portfolio_test" } });
      const scope = { authorizedCharacterIds: [historicalId] };
      const query = (search?: string) => characterPortfolioQuerySchema.parse({ search, includePerformance: false });
      const list = await listCharacterPortfolioData(prisma, query(), scope);
      expect(list.items[0]?.name).toBe(loaded.ok ? loaded.snapshot.soul.name : null);
      for (const search of [soul.identity.name, soul.identity.characterPromise]) {
        const found = await listCharacterPortfolioData(prisma, query(search), scope);
        expect(found.items.map((item) => item.characterId)).toEqual([historicalId]);
      }
    } finally {
      await prisma.characterContentVersion.deleteMany({ where: { characterId: historicalId } });
      await prisma.characterProject.deleteMany({ where: { id: historicalProjectId } });
      await prisma.character.delete({ where: { id: historicalId } });
    }
  });

  it("paginates a large operational population without expanding it into bind parameters", async () => {
    const prefix = `large-portfolio-${suffix}-`;
    const size = 65_536;
    const query = characterPortfolioQuerySchema.parse({ includePerformance: false, limit: 1, sort: "project_id_asc" });
    const baseline = await listCharacterPortfolioData(prisma, query);
    try {
      // A set-based fixture exposes the actual database parameter boundary quickly.
      await prisma.$executeRaw`INSERT INTO "characters" (id, name, age, description, source, appearance, "advancedDetails", "updatedAt")
        SELECT ${prefix} || n::text, 'Large population role', 29, 'Large population regression', 'official', '{}'::jsonb, '{}'::jsonb, NOW()
        FROM generate_series(1, ${size}) AS n`;
      await prisma.$executeRaw`INSERT INTO "character_projects" (id, "characterId", "activeKey", "updatedAt")
        SELECT ${prefix} || n::text, ${prefix} || n::text, ${prefix} || n::text, NOW()
        FROM generate_series(1, ${size}) AS n`;
      await prisma.$executeRaw`INSERT INTO "character_content_versions" (id, "characterId", version, "contentHash", "personaSnapshot", "openingSnapshot", "appearanceSnapshot", "sourceType")
        SELECT ${prefix} || n::text, ${prefix} || n::text, 1, ${prefix} || n::text,
          jsonb_build_object('name', ${prefix} || 'draft', 'age', 29, 'gender', 'female', 'description', 'Large draft population'),
          '{"firstMessage":"Hello."}'::jsonb, '{}'::jsonb, 'large_portfolio_regression'
        FROM generate_series(1, ${size}) AS n`;
      const first = await listCharacterPortfolioData(prisma, query);
      expect(first.items).toHaveLength(1);
      expect(first.pageInfo.totalCount).toBe(baseline.pageInfo.totalCount! + size);
      const next = await listCharacterPortfolioData(prisma, { ...query, cursor: first.pageInfo.endCursor! });
      expect(next.items).toHaveLength(1);
      expect(next.items[0]?.characterId).not.toBe(first.items[0]?.characterId);
      const found = await listCharacterPortfolioData(prisma, { ...query, search: `${prefix}draft` });
      expect(found.pageInfo.totalCount).toBe(size);
      expect(found.items[0]?.characterId.startsWith(prefix)).toBe(true);
    } finally {
      await prisma.characterContentVersion.deleteMany({ where: { characterId: { startsWith: prefix } } });
      await prisma.characterProject.deleteMany({ where: { id: { startsWith: prefix } } });
      await prisma.character.deleteMany({ where: { id: { startsWith: prefix } } });
    }
  }, 30_000);

  it("keeps customer/internal scope, excluded creators and empty permission scopes consistent", async () => {
    const classes = ["customer", "internal", "fixture", "audit"] as const;
    const users = classes.map((dataClass) => ({ id: `portfolio-scope-user-${dataClass}-${suffix}`, email: `portfolio-scope-${dataClass}-${suffix}@example.test`, dataClass }));
    const roles = classes.map((dataClass, index) => ({ id: `portfolio-scope-role-${dataClass}-${suffix}`, creatorId: users[index].id, name: `Portfolio scope ${dataClass}`, age: 29, description: "Operational scope regression", source: "user", appearance: {}, advancedDetails: {} }));
    const projects = roles.map((role) => ({ id: `${role.id}-project`, characterId: role.id, activeKey: `${role.id}-project` }));
    await prisma.user.createMany({ data: users });
    try {
      await prisma.character.createMany({ data: roles });
      await prisma.characterProject.createMany({ data: projects });
      const query = characterPortfolioQuerySchema.parse({ includePerformance: false, search: "Operational scope regression" });
      const result = await listCharacterPortfolioData(prisma, query, { authorizedCharacterIds: roles.map((role) => role.id) });
      expect(result.items.map((item) => item.characterId).sort()).toEqual(roles.slice(0, 2).map((role) => role.id).sort());
      expect(result.pageInfo.totalCount).toBe(2);
      const denied = await listCharacterPortfolioData(prisma, query, { authorizedCharacterIds: [] });
      expect(denied.items).toEqual([]);
      expect(denied.pageInfo.totalCount).toBe(0);
    } finally {
      await prisma.characterProject.deleteMany({ where: { id: { in: projects.map((project) => project.id) } } });
      await prisma.character.deleteMany({ where: { id: { in: roles.map((role) => role.id) } } });
      await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    }
  });
});
