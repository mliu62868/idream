import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { jobQueue } from "@/server/jobs/queue";
import {
  clearSessionCookie,
  createAnonymousId,
  createSessionToken,
  getAuthCtx,
  hashPassword,
  mergeAnonymous,
  requireAdmin,
  requireAgeGate,
  requireAgeVerified,
  requireUser,
  sessionCookie,
  ageGateCookie,
  anonymousCookie,
  verifyPassword,
} from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { nameMatch } from "@/server/lib/db/search";
import { AppError, Errors } from "@/server/lib/errors";
import { empty, fail, ok } from "@/server/lib/http";
import { providers } from "@/server/providers";

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
type JsonRecord = Record<string, Prisma.JsonValue>;

const credentialProvider = "credential";
const defaultImage = "/images/ourdream/card-sarah-mercer.webp";

const signupSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  password: z.string().min(8),
  name: z.string().trim().min(1).max(80).optional(),
});

const loginSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1),
});

const ageGateSchema = z.object({
  country: z.string().max(2).optional(),
  sourcePath: z.string().max(240).optional(),
  policyVersion: z.string().max(80).default("2026-06-13"),
});

const draftCreateSchema = z.object({
  gender: z.enum(["female", "male", "trans"]).optional(),
  style: z.enum(["realistic", "anime", "hybrid", "other"]).optional(),
  name: z.string().trim().min(1).max(80).optional(),
});

const draftPatchSchema = z.object({
  step: z.number().int().min(0).max(12).optional(),
  gender: z.enum(["female", "male", "trans"]).nullable().optional(),
  style: z.enum(["realistic", "anime", "hybrid", "other"]).nullable().optional(),
  name: z.string().trim().min(1).max(80).nullable().optional(),
  appearance: z.record(z.string(), z.unknown()).optional(),
  hair: z.record(z.string(), z.unknown()).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
  advancedDetails: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

const draftSubmitSchema = z.object({
  visibility: z.enum(["private", "unlisted", "public"]).default("private"),
  description: z.string().trim().min(1).max(1_500).optional(),
  age: z.number().int().min(18).max(99).default(21),
});

const chatSessionSchema = z.object({
  characterId: z.string().min(1),
});

const chatMessageSchema = z.object({
  content: z.string().trim().min(1).max(4_000),
});

const generationJobSchema = z.object({
  mode: z.enum(["image", "video"]).default("image"),
  characterId: z.string().min(1).optional(),
  prompt: z.string().trim().max(2_000).optional(),
  negativePrompt: z.string().trim().max(1_000).optional(),
  controls: z.record(z.string(), z.unknown()).default({}),
  presetIds: z.array(z.string()).max(12).default([]),
  orientation: z.string().max(20).optional(),
  outputCount: z.number().int().min(1).max(4).default(1),
  model: z.string().max(80).optional(),
});

const presetCreateSchema = z.object({
  type: z.enum(["background", "pose", "outfit", "mode"]),
  category: z.string().max(80).optional(),
  label: z.string().trim().min(1).max(80),
  controls: z.record(z.string(), z.unknown()).default({}),
  visibility: z.enum(["private", "public", "unlisted"]).default("private"),
});

const checkoutSchema = z.object({
  planId: z.string().optional(),
  slug: z.enum(["premium", "deluxe"]).optional(),
  billingPeriod: z.enum(["monthly", "yearly"]).default("monthly"),
  returnPath: z.string().max(240).default("/profile"),
  autoConfirm: z.boolean().default(true),
});

const reportSchema = z.object({
  targetType: z.string().trim().min(1).max(80),
  targetId: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).optional(),
});

const profilePatchSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  image: z.string().url().optional(),
});

const preferencesPatchSchema = z.object({
  locale: z.string().trim().min(2).max(16).optional(),
  mutedTags: z.array(z.string()).max(80).optional(),
  safeModeFlags: z.record(z.string(), z.unknown()).optional(),
  notificationSettings: z.record(z.string(), z.unknown()).optional(),
});

const redeemSchema = z.object({
  code: z.string().trim().min(3).max(80),
});

const adminDecisionSchema = z.object({
  decision: z.enum(["actioned", "no_violation", "duplicate", "escalated", "closed"]),
  policyCode: z.string().max(120).optional(),
  notes: z.string().max(2_000).optional(),
});

const eventSchema = z.object({
  name: z.string().trim().min(1).max(120),
  props: z.record(z.string(), z.unknown()).default({}),
});

export async function dispatchV1(request: Request, segments: string[]) {
  try {
    return await dispatchV1Unsafe(request, segments);
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    if (error instanceof z.ZodError) {
      return fail(new AppError("bad_request", "Validation failed", error.flatten()));
    }
    return fail(new AppError("internal", "Internal error"));
  }
}

async function dispatchV1Unsafe(request: Request, segments: string[]) {
  const method = request.method as ApiMethod;
  const [resource, id, action, child] = segments;

  if (!resource) return ok({ service: "idream-api", version: "v1" });

  if (resource === "auth") {
    if (id === "signup" && method === "POST") return signup(request);
    if (id === "login" && method === "POST") return login(request);
    if (id === "logout" && method === "POST") return logout(request);
  }

  if (resource === "me") {
    if (!id && method === "GET") return me(request);
    if (id === "preferences" && method === "PATCH") return updatePreferences(request);
  }

  if (resource === "age-gate" && id === "accept" && method === "POST") {
    return acceptAgeGate(request);
  }

  if (resource === "age-verification") {
    if (id === "status" && method === "GET") return ageVerificationStatus(request);
    if (id === "sessions" && method === "POST") return createAgeVerificationSession(request);
    if (id === "webhooks" && action && method === "POST") {
      return ageVerificationWebhook(request, action);
    }
  }

  if (resource === "characters") {
    if (!id && method === "GET") return listCharacters(request);
    if (id && !action && method === "GET") return getCharacter(request, id);
    if (id && action === "like" && method === "POST") return likeCharacter(request, id);
    if (id && action === "like" && method === "DELETE") return unlikeCharacter(request, id);
    if (id && action === "report" && method === "POST") {
      return submitReport(request, { targetType: "character", targetId: id });
    }
    if (id && action === "duplicate" && method === "POST") return duplicateCharacter(request, id);
    if (id && !action && method === "PATCH") return updateCharacter(request, id);
    if (id && !action && method === "DELETE") return archiveCharacter(request, id);
  }

  if (resource === "tags" && !id && method === "GET") return listTags();
  if (resource === "search" && id === "suggest" && method === "GET") return suggest(request);

  if (resource === "character-drafts") {
    if (!id && method === "POST") return createDraft(request);
    if (id && !action && method === "PATCH") return updateDraft(request, id);
    if (id && action === "preview" && method === "POST") return previewDraft(request, id);
    if (id && action === "submit" && method === "POST") return submitDraft(request, id);
    if (id && action === "tags" && method === "POST") return updateDraftTags(request, id);
  }

  if (resource === "chat") {
    if (id === "sessions" && !action && method === "GET") return listChatSessions(request);
    if (id === "sessions" && !action && method === "POST") return createChatSession(request);
    if (id === "sessions" && action && !child && method === "GET") {
      return getChatSession(request, action);
    }
    if (id === "sessions" && action && !child && method === "DELETE") {
      return archiveChatSession(request, action);
    }
    if (id === "sessions" && action && child === "messages" && method === "POST") {
      return sendChatMessage(request, action);
    }
  }

  if (resource === "messages") {
    if (id && action === "regenerate" && method === "POST") return regenerateMessage(request, id);
    if (id && !action && method === "DELETE") return deleteMessage(request, id);
  }

  if (resource === "generation") {
    if (id === "jobs" && !action && method === "POST") return createGenerationJob(request);
    if (id === "jobs" && action && !child && method === "GET") return getGenerationJob(request, action);
    if (id === "jobs" && action && child === "retry" && method === "POST") {
      return retryGenerationJob(request, action);
    }
    if (id === "presets" && !action && method === "GET") return listPresets(request);
    if (id === "presets" && !action && method === "POST") return createPreset(request);
    if (id === "presets" && action && method === "PATCH") return updatePreset(request, action);
    if (id === "presets" && action && method === "DELETE") return archivePreset(request, action);
  }

  if (resource === "media") {
    if (!id && method === "GET") return listMedia(request);
    if (id === "bulk" && method === "POST") return bulkMedia(request);
    if (id && action === "like" && method === "POST") return likeMedia(request, id);
    if (id && action === "like" && method === "DELETE") return unlikeMedia(request, id);
    if (id && action === "download" && method === "GET") return downloadMedia(request, id);
    if (id && !action && method === "DELETE") return deleteMedia(request, id);
  }

  if (resource === "plans" && !id && method === "GET") return listPlans();
  if (resource === "billing") {
    if (id === "checkout" && method === "POST") return checkout(request);
    if (id === "portal" && method === "POST") return billingPortal(request);
    if (id === "webhooks" && action && method === "POST") return billingWebhook(request, action);
  }
  if (resource === "dreamcoins" && method === "GET") return dreamcoins(request);

  if (resource === "library" && id && method === "GET") return library(request, id);

  if (resource === "profile") {
    if (!id && method === "GET") return profile(request);
    if (!id && method === "PATCH") return updateProfile(request);
    if (id === "preferences" && method === "GET") return profilePreferences(request);
    if (id === "preferences" && method === "PATCH") return updatePreferences(request);
    if (id === "language" && method === "PATCH") return updateLanguage(request);
  }

  if (resource === "redeem-codes" && id === "redeem" && method === "POST") {
    return redeemCode(request);
  }

  if (resource === "referrals") {
    if (!id && method === "GET") return referrals(request);
    if (id === "invite" && method === "POST") return inviteReferral(request);
  }

  if (resource === "account") {
    if (id === "sign-out-all" && method === "POST") return signOutAll(request);
    if (id === "delete-request" && method === "POST") return deleteRequest(request);
  }

  if (resource === "reports") {
    if (!id && method === "POST") return submitReport(request);
    if (id && method === "GET") return reportStatus(request, id);
  }

  if (resource === "appeals" && !id && method === "POST") return createAppeal(request);
  if (resource === "policies" && !id && method === "GET") return policies();

  if (resource === "admin" && id === "moderation") {
    if (action === "queue" && method === "GET") return adminQueue(request);
    if (action && child === "decision" && method === "POST") {
      return adminDecision(request, action);
    }
  }

  if (resource === "users" && id && action === "follow") {
    if (method === "POST") return followUser(request, id);
    if (method === "DELETE") return unfollowUser(request, id);
  }

  if (resource === "events" && id === "track" && method === "POST") return track(request);
  if (resource === "feed") return feed(request, segments);
  if (resource === "community") return community(request, segments);

  throw Errors.notFound("API route not found", { path: `/${segments.join("/")}` });
}

async function signup(request: Request) {
  const body = signupSchema.parse(await jsonBody(request));
  const ctx = await getAuthCtx(request);
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) throw Errors.conflict("Email already registered");

  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const token = createSessionToken();
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: body.email,
        emailVerified: true,
        name: body.name,
        displayName: body.name ?? body.email.split("@")[0],
        anonymousId: ctx.anonymousId,
        accounts: {
          create: {
            providerId: credentialProvider,
            accountId: body.email,
            password: hashPassword(body.password),
          },
        },
        sessions: {
          create: {
            token,
            expiresAt,
          },
        },
        preferences: {
          create: {
            mutedTags: [],
            safeModeFlags: {},
            notificationSettings: {},
          },
        },
      },
    });
    await appendLedger(tx, created.id, 250, "signup_bonus", "signup");
    return created;
  });

  await mergeAnonymous(user.id, ctx.anonymousId);
  await trackEvent("signup", { source: "api" }, { userId: user.id, anonymousId: ctx.anonymousId });

  const response = ok({
    user: userDTO(user),
    session: { expiresAt },
  });
  response.headers.append("set-cookie", sessionCookie(token, expiresAt));
  return response;
}

async function login(request: Request) {
  const body = loginSchema.parse(await jsonBody(request));
  const account = await prisma.account.findUnique({
    where: {
      providerId_accountId: {
        providerId: credentialProvider,
        accountId: body.email,
      },
    },
    include: { user: true },
  });

  if (!account || !verifyPassword(body.password, account.password)) {
    throw Errors.unauthorized("Invalid email or password");
  }

  if (account.user.status !== "active" || account.user.deletedAt) {
    throw Errors.forbidden("Account is not active");
  }

  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  await prisma.session.create({
    data: {
      userId: account.userId,
      token,
      expiresAt,
      userAgent: request.headers.get("user-agent"),
    },
  });
  await trackEvent("login", { source: "api" }, { userId: account.userId });

  const response = ok({
    user: userDTO(account.user),
    session: { expiresAt },
  });
  response.headers.append("set-cookie", sessionCookie(token, expiresAt));
  return response;
}

async function logout(request: Request) {
  const cookies = parseRequestCookies(request);
  const token = cookies.get("idream_session");
  if (token) await prisma.session.deleteMany({ where: { token } });
  const response = empty();
  response.headers.append("set-cookie", clearSessionCookie());
  return response;
}

async function me(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = ctx.userId
    ? await prisma.user.findUnique({ where: { id: ctx.userId } })
    : null;
  const entitlements = ctx.userId ? await entitlementMap(ctx.userId) : {};
  const balance = ctx.userId ? await dreamcoinBalance(ctx.userId) : 0;

  return ok({
    user: user ? userDTO(user) : null,
    anonymousId: ctx.anonymousId,
    ageGate: { accepted: ctx.ageGateAccepted },
    ageVerification: { status: ctx.ageVerificationStatus },
    entitlements,
    dreamcoins: { balance },
  });
}

async function acceptAgeGate(request: Request) {
  const body = ageGateSchema.parse(await jsonBody(request));
  const ctx = await getAuthCtx(request);
  const anonymousId = ctx.anonymousId ?? createAnonymousId();

  await prisma.ageGateAcceptance.create({
    data: {
      userId: ctx.userId,
      anonymousId,
      country: body.country,
      sourcePath: body.sourcePath,
      policyVersion: body.policyVersion,
    },
  });
  await trackEvent("age_gate_accepted", { sourcePath: body.sourcePath }, ctx);

  const response = ok({ accepted: true, anonymousId });
  response.headers.append("set-cookie", ageGateCookie());
  response.headers.append("set-cookie", anonymousCookie(anonymousId));
  return response;
}

async function ageVerificationStatus(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  return ok({ status: await currentAgeVerificationStatus(user.id) });
}

async function createAgeVerificationSession(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const result = await providers.ageVerification.createSession({ userId: user.id });
  if (!result.ok) throw Errors.internal(result.error.message, result.error);

  const verification = await prisma.ageVerification.create({
    data: {
      userId: user.id,
      provider: result.data.provider,
      providerVerificationId: result.data.providerVerificationId,
      status: result.data.status,
      metadata: {},
    },
  });

  return ok({ verification, url: result.data.url });
}

// SPEC (BackendFeatureSpec §5.1): identity-verification provider callback.
// INVARIANTS: idempotent by provider event id; applies the reported status to
// the user's latest age_verification exactly once.
async function ageVerificationWebhook(request: Request, provider: string) {
  const payload = await jsonBody(request);
  const eventId =
    request.headers.get("x-provider-event-id") ??
    (isRecord(payload) && typeof payload.providerEventId === "string"
      ? payload.providerEventId
      : cryptoRandomId("age_evt"));

  const already = await prisma.providerEvent.findUnique({
    where: { provider_providerEventId: { provider, providerEventId: eventId } },
  });
  if (already?.processedAt) return ok({ processed: false, idempotent: true });

  const event = await prisma.providerEvent.upsert({
    where: { provider_providerEventId: { provider, providerEventId: eventId } },
    update: { payload: toInputJson(payload) },
    create: {
      provider,
      providerEventId: eventId,
      type: "age.verification",
      payload: toInputJson(payload),
    },
  });

  const userId =
    isRecord(payload) && typeof payload.userId === "string" ? payload.userId : undefined;
  const status =
    isRecord(payload) && typeof payload.status === "string" ? payload.status : "verified";
  if (userId) {
    const latest = await prisma.ageVerification.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    const verifiedAt = status === "verified" ? new Date() : null;
    if (latest) {
      await prisma.ageVerification.update({
        where: { id: latest.id },
        data: { status, provider, verifiedAt },
      });
    } else {
      await prisma.ageVerification.create({
        data: { userId, provider, status, verifiedAt, metadata: {} },
      });
    }
  }

  await jobQueue.enqueue({
    queue: "age.verification.webhook",
    payload: { providerEventId: eventId, userId },
    dedupeKey: `age.verification.webhook:${eventId}`,
  });
  await prisma.providerEvent.update({
    where: { id: event.id },
    data: { processedAt: new Date() },
  });
  return ok({ processed: true });
}

async function listCharacters(request: Request) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const tags = url.searchParams.getAll("tags").flatMap((value) => value.split(",")).filter(Boolean);
  const limit = clampInt(url.searchParams.get("limit"), 1, 60, 28);
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const sort = url.searchParams.get("sort") ?? "popular";

  const where: Prisma.CharacterWhereInput = {
    visibility: "public",
    status: "approved",
    deletedAt: null,
    gender: url.searchParams.get("gender") ?? undefined,
    style: url.searchParams.get("style") ?? undefined,
    age: {
      gte: intParam(url.searchParams.get("age_min")),
      lte: intParam(url.searchParams.get("age_max")),
    },
    tags:
      tags.length > 0
        ? {
            some: {
              tag: {
                slug: { in: tags.map(slugify) },
              },
            },
          }
        : undefined,
  };

  const nameFilter = nameMatch(q);
  if (nameFilter) {
    where.OR = [
      { name: nameFilter },
      { description: { contains: q.trim() } },
    ];
  }

  const characters = await prisma.character.findMany({
    where,
    include: characterInclude(ctx.userId),
    orderBy:
      sort === "newest"
        ? [{ createdAt: "desc" }]
        : [{ stats: { chatsCount: "desc" } }, { stats: { likesCount: "desc" } }],
    skip: cursor,
    take: limit + 1,
  });

  const page = characters.slice(0, limit);
  return ok({
    items: page.map((character) => characterDTO(character)),
    nextCursor: characters.length > limit ? encodeCursor(cursor + limit) : null,
  });
}

async function getCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const character = await prisma.character.findFirst({
    where: {
      id,
      deletedAt: null,
      OR: [
        { visibility: "public", status: "approved" },
        ctx.userId ? { creatorId: ctx.userId } : {},
      ].filter((item) => Object.keys(item).length > 0),
    },
    include: characterInclude(ctx.userId),
  });
  if (!character) throw Errors.notFound("Character not found");

  await prisma.characterStats.upsert({
    where: { characterId: character.id },
    update: {
      viewsCount: { increment: 1 },
      lastActivityAt: new Date(),
    },
    create: {
      characterId: character.id,
      viewsCount: 1,
      lastActivityAt: new Date(),
    },
  });

  await trackEvent("character_viewed", { characterId: character.id }, ctx);
  return ok({ character: characterDTO(character) });
}

async function likeCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  await prisma.$transaction([
    prisma.characterLike.upsert({
      where: { userId_characterId: { userId: user.id, characterId: id } },
      update: {},
      create: { userId: user.id, characterId: id },
    }),
    prisma.characterStats.upsert({
      where: { characterId: id },
      update: { likesCount: { increment: 1 } },
      create: { characterId: id, likesCount: 1 },
    }),
  ]);
  return ok({ liked: true });
}

async function unlikeCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const deleted = await prisma.characterLike.deleteMany({
    where: { userId: user.id, characterId: id },
  });
  if (deleted.count > 0) {
    await prisma.characterStats.updateMany({
      where: { characterId: id, likesCount: { gt: 0 } },
      data: { likesCount: { decrement: 1 } },
    });
  }
  return ok({ liked: false });
}

async function listTags() {
  const tags = await prisma.tag.findMany({
    orderBy: [{ category: "asc" }, { label: "asc" }],
  });
  return ok({ items: tags });
}

async function suggest(request: Request) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const normalized = q.trim();
  if (!normalized) return ok({ characters: [], tags: [] });

  const [characters, tags] = await Promise.all([
    prisma.character.findMany({
      where: {
        visibility: "public",
        status: "approved",
        name: { contains: normalized },
      },
      include: characterInclude(ctx.userId),
      take: 8,
    }),
    prisma.tag.findMany({
      where: { label: { contains: normalized } },
      take: 8,
    }),
  ]);

  return ok({
    characters: characters.map((character) => characterDTO(character)),
    tags,
  });
}

async function createDraft(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = draftCreateSchema.parse(await jsonBody(request));
  const draft = await prisma.characterDraft.create({
    data: {
      ownerId: user.id,
      gender: body.gender,
      style: body.style,
      name: body.name,
      appearance: {},
      hair: {},
      body: {},
      advancedDetails: {},
      tags: [],
    },
  });
  await trackEvent("character_create_started", { draftId: draft.id }, ctx);
  return ok({ draft });
}

async function updateDraft(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = draftPatchSchema.parse(await jsonBody(request));
  await assertDraftOwner(id, user.id);

  const draft = await prisma.characterDraft.update({
    where: { id },
    data: {
      step: body.step,
      gender: body.gender,
      style: body.style,
      name: body.name,
      appearance: body.appearance ? toInputJson(body.appearance) : undefined,
      hair: body.hair ? toInputJson(body.hair) : undefined,
      body: body.body ? toInputJson(body.body) : undefined,
      advancedDetails: body.advancedDetails ? toInputJson(body.advancedDetails) : undefined,
      tags: body.tags ? toInputJson(body.tags.map(slugify)) : undefined,
    },
  });

  return ok({ draft });
}

async function previewDraft(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const draft = await assertDraftOwner(id, user.id);
  const moderation = await moderateText(
    "character_draft",
    id,
    `${draft.name ?? ""} ${JSON.stringify(draft.advancedDetails)}`,
    "input",
  );
  if (moderation.status === "blocked") {
    throw Errors.forbidden("Draft failed safety checks", moderation);
  }

  const job = await prisma.characterPreviewJob.create({
    data: {
      draftId: id,
      status: "running",
      provider: "mock",
    },
  });
  await jobQueue.enqueue({
    queue: "character.preview",
    payload: { draftId: id, previewJobId: job.id },
    dedupeKey: `character.preview:${id}`,
  });

  const image = await providers.image.generate({
    prompt: draft.name ?? "custom character",
    count: 1,
    seed: id,
  });
  if (!image.ok) throw Errors.internal(image.error.message, image.error);

  const asset = await prisma.mediaAsset.create({
    data: {
      ownerId: user.id,
      type: "image",
      url: defaultImage,
      thumbnailUrl: defaultImage,
      prompt: draft.name,
      visibility: "private",
      safetyStatus: "passed",
      metadata: { providerKey: image.data.assets[0]?.key ?? "mock" },
    },
  });

  const completed = await prisma.characterPreviewJob.update({
    where: { id: job.id },
    data: {
      status: "completed",
      resultAssetId: asset.id,
      completedAt: new Date(),
    },
  });
  await prisma.characterDraft.update({
    where: { id },
    data: { previewJobId: completed.id },
  });
  return ok({ previewJob: completed, asset: mediaDTO(asset) });
}

async function submitDraft(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = draftSubmitSchema.parse(await jsonBody(request));
  const draft = await assertDraftOwner(id, user.id);
  if (!draft.name) throw Errors.badRequest("Draft name is required before submit");
  const draftName = draft.name;

  const description =
    body.description ??
    `Custom ${draft.style ?? "realistic"} companion created from the Ourdream creator.`;
  const moderation = await moderateText(
    "character_draft",
    id,
    `${draft.name} ${description} ${JSON.stringify(draft.advancedDetails)}`,
    "input",
  );
  if (moderation.status === "blocked") {
    throw Errors.forbidden("Character failed safety checks", moderation);
  }

  const character = await prisma.$transaction(async (tx) => {
    const created = await tx.character.create({
      data: {
        creatorId: user.id,
        name: draftName,
        age: body.age,
        description,
        visibility: body.visibility,
        status: body.visibility === "public" ? "pending_review" : "approved",
        style: draft.style ?? "realistic",
        gender: draft.gender ?? "female",
        appearance: toInputJson(draft.appearance ?? {}),
        advancedDetails: toInputJson(draft.advancedDetails ?? {}),
      },
    });

    await tx.characterStats.create({ data: { characterId: created.id } });
    await tx.characterSubmission.create({
      data: {
        characterId: created.id,
        submitterId: user.id,
        status: body.visibility === "public" ? "pending" : "approved",
      },
    });

    return created;
  });

  await jobQueue.enqueue({
    queue: "moderation.input",
    payload: { targetType: "character", targetId: character.id },
    dedupeKey: `moderation.input:character:${character.id}`,
  });
  await trackEvent("character_created", { characterId: character.id }, ctx);
  return ok({ character });
}

async function updateDraftTags(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = z.object({ tags: z.array(z.string()).max(12) }).parse(await jsonBody(request));
  await assertDraftOwner(id, user.id);
  const draft = await prisma.characterDraft.update({
    where: { id },
    data: { tags: toInputJson(body.tags.map(slugify)) },
  });
  return ok({ draft });
}

async function createChatSession(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = chatSessionSchema.parse(await jsonBody(request));
  const character = await readableCharacter(body.characterId, user.id);

  const session =
    (await prisma.chatSession.findFirst({
      where: {
        userId: user.id,
        characterId: character.id,
        status: "active",
      },
      orderBy: { createdAt: "desc" },
    })) ??
    (await prisma.chatSession.create({
      data: {
        userId: user.id,
        characterId: character.id,
        title: character.name,
      },
    }));

  await trackEvent("chat_started", { characterId: character.id, sessionId: session.id }, ctx);
  return ok({ session });
}

async function listChatSessions(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const sessions = await prisma.chatSession.findMany({
    where: { userId: user.id, status: { not: "deleted" } },
    include: {
      character: { include: { imageAsset: true, stats: true, tags: { include: { tag: true } } } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
  });
  return ok({ items: sessions });
}

async function getChatSession(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const session = await prisma.chatSession.findFirst({
    where: { id, userId: user.id, status: { not: "deleted" } },
    include: {
      character: { include: { imageAsset: true, stats: true, tags: { include: { tag: true } } } },
      messages: {
        where: { status: { not: "deleted" } },
        orderBy: { createdAt: "asc" },
        include: { versions: true },
      },
    },
  });
  if (!session) throw Errors.notFound("Chat session not found");
  return ok({ session });
}

async function sendChatMessage(request: Request, sessionId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = chatMessageSchema.parse(await jsonBody(request));
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: user.id, status: "active" },
    include: { character: true, messages: { orderBy: { createdAt: "asc" }, take: 30 } },
  });
  if (!session) throw Errors.notFound("Chat session not found");

  const moderation = await moderateText("message", sessionId, body.content, "input");
  const userMessage = await prisma.message.create({
    data: {
      sessionId,
      role: "user",
      content: body.content,
      status: moderation.status === "blocked" ? "blocked" : "sent",
      safetyStatus: moderation.status,
    },
  });
  if (moderation.status === "blocked") {
    return ok({
      blocked: true,
      message: userMessage,
      error: { code: moderation.policyCode ?? "unsafe_request" },
    });
  }

  await jobQueue.enqueue({
    queue: "chat.generate",
    payload: { sessionId, userMessageId: userMessage.id },
  });

  const history = session.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    }));
  const chunks: string[] = [];
  for await (const chunk of providers.chat.stream({
    characterName: session.character.name,
    messages: [
      { role: "system", content: session.character.systemPrompt ?? session.character.description },
      ...history,
      { role: "user", content: body.content },
    ],
  })) {
    chunks.push(chunk.delta);
  }
  const content = chunks.join("");
  const outputModeration = await moderateText("message", sessionId, content, "output");
  const assistant = await prisma.message.create({
    data: {
      sessionId,
      role: "assistant",
      content,
      model: "mock",
      status: outputModeration.status === "blocked" ? "blocked" : "sent",
      safetyStatus: outputModeration.status,
      versions: {
        create: {
          content,
          model: "mock",
          selected: true,
        },
      },
    },
    include: { versions: true },
  });

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { lastMessageAt: new Date() },
  });
  await incrementChatUsage(user.id, sessionId);
  await trackEvent("message_sent", { sessionId, characterId: session.characterId }, ctx);

  return ok({ userMessage, assistant });
}

async function archiveChatSession(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.chatSession.updateMany({
    where: { id, userId: user.id },
    data: { status: "deleted" },
  });
  return ok({ archived: true });
}

async function regenerateMessage(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const message = await prisma.message.findFirst({
    where: {
      id,
      role: "assistant",
      session: { userId: user.id },
    },
  });
  if (!message) throw Errors.notFound("Message not found");

  const content = `${message.content}\n\nRegenerated variant.`;
  const version = await prisma.messageVersion.create({
    data: { messageId: id, content, model: "mock", selected: false },
  });
  return ok({ version });
}

async function deleteMessage(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.message.updateMany({
    where: { id, session: { userId: user.id } },
    data: { status: "deleted" },
  });
  return ok({ deleted: true });
}

async function createGenerationJob(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = generationJobSchema.parse(await jsonBody(request));
  const entitlements = await entitlementMap(user.id);

  if (body.mode === "video" && !entitlements.video_generation) {
    throw Errors.paymentRequired("Video generation requires Deluxe entitlement");
  }
  if ((body.prompt || body.negativePrompt) && !entitlements.premium_controls) {
    throw Errors.paymentRequired("Custom prompt controls require Premium");
  }
  if (body.characterId) await readableCharacter(body.characterId, user.id);

  const cost = generationCost(body.mode, body.outputCount);
  const balance = await dreamcoinBalance(user.id);
  if (balance < cost) {
    throw Errors.paymentRequired("Insufficient dreamcoins", { balance, cost });
  }

  const moderation = await moderateText(
    "generation_job",
    user.id,
    `${body.prompt ?? ""} ${body.negativePrompt ?? ""}`,
    "input",
  );

  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.generationJob.create({
      data: {
        userId: user.id,
        characterId: body.characterId,
        mode: body.mode,
        prompt: body.prompt,
        negativePrompt: body.negativePrompt,
        controls: toInputJson(body.controls),
        presetIds: toInputJson(body.presetIds),
        model: body.model ?? "mock",
        orientation: body.orientation,
        outputCount: body.outputCount,
        status: moderation.status === "blocked" ? "blocked" : "running",
        costDreamcoins: cost,
        provider: "mock",
      },
    });
    await appendLedger(tx, user.id, -cost, "generation_spend", created.id);
    return created;
  });

  if (moderation.status === "blocked") {
    await refundGeneration(user.id, job.id, cost);
    return ok({ job: { ...job, status: "blocked" } });
  }

  await jobQueue.enqueue({
    queue: body.mode === "video" ? "generation.video" : "generation.image",
    payload: { jobId: job.id },
    dedupeKey: `generation:${job.id}`,
  });

  const assetUrl = await imageUrlForCharacter(body.characterId);
  const providerResult =
    body.mode === "video"
      ? await providers.video.generate({
          prompt: body.prompt ?? "video generation",
          seconds: 4,
          seed: job.id,
        })
      : await providers.image.generate({
          prompt: body.prompt ?? "image generation",
          count: body.outputCount,
          seed: job.id,
        });

  if (!providerResult.ok) {
    await prisma.generationJob.update({
      where: { id: job.id },
      data: { status: "failed", errorCode: providerResult.error.code },
    });
    await refundGeneration(user.id, job.id, cost);
    return ok({ job: await prisma.generationJob.findUnique({ where: { id: job.id } }) });
  }

  const assets = await Promise.all(
    Array.from({ length: body.outputCount }, (_, index) =>
      prisma.mediaAsset.create({
        data: {
          ownerId: user.id,
          sourceJobId: job.id,
          characterId: body.characterId,
          type: body.mode,
          url: assetUrl,
          thumbnailUrl: assetUrl,
          prompt: body.prompt,
          visibility: "private",
          safetyStatus: "passed",
          metadata: { index, provider: "mock" },
        },
      }),
    ),
  );
  const completed = await prisma.generationJob.update({
    where: { id: job.id },
    data: { status: "completed", completedAt: new Date() },
    include: { assets: true },
  });
  await trackEvent("generation_completed", { jobId: job.id, mode: body.mode }, ctx);
  return ok({ job: completed, assets: assets.map(mediaDTO) });
}

async function getGenerationJob(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const job = await prisma.generationJob.findFirst({
    where: { id, userId: user.id },
    include: { assets: true },
  });
  if (!job) throw Errors.notFound("Generation job not found");
  return ok({ job });
}

async function retryGenerationJob(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const job = await prisma.generationJob.findFirst({ where: { id, userId: user.id } });
  if (!job) throw Errors.notFound("Generation job not found");
  if (job.status !== "failed" && job.status !== "refunded") {
    throw Errors.badRequest("Only failed or refunded jobs can be retried");
  }
  await prisma.generationJob.update({
    where: { id },
    data: { status: "queued", errorCode: null },
  });
  await jobQueue.enqueue({ queue: `generation.${job.mode}`, payload: { jobId: id } });
  return ok({ queued: true });
}

async function listPresets(request: Request) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const scope = url.searchParams.get("scope");
  const q = url.searchParams.get("q");
  const ctx = await getAuthCtx(request);
  const items = await prisma.generationPreset.findMany({
    where: {
      status: "active",
      type: type ?? undefined,
      scope: scope ?? undefined,
      OR: ctx.userId
        ? [{ ownerId: ctx.userId }, { scope: { in: ["built_in", "community"] } }]
        : [{ scope: "built_in" }],
      label: q ? { contains: q } : undefined,
    },
    orderBy: [{ scope: "asc" }, { type: "asc" }, { label: "asc" }],
  });
  return ok({ items });
}

async function createPreset(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = presetCreateSchema.parse(await jsonBody(request));
  const preset = await prisma.generationPreset.create({
    data: {
      ownerId: user.id,
      scope: "user",
      type: body.type,
      category: body.category,
      label: body.label,
      controls: toInputJson(body.controls),
      visibility: body.visibility,
    },
  });
  return ok({ preset });
}

async function archivePreset(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.generationPreset.updateMany({
    where: { id, ownerId: user.id },
    data: { status: "archived" },
  });
  return ok({ archived: true });
}

async function updatePreset(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = z
    .object({
      label: z.string().trim().min(1).max(80).optional(),
      category: z.string().max(80).optional(),
      controls: z.record(z.string(), z.unknown()).optional(),
      visibility: z.enum(["private", "public", "unlisted"]).optional(),
    })
    .parse(await jsonBody(request));
  // Owners edit their own presets; admins may also manage built-in/community presets.
  const where: Prisma.GenerationPresetWhereInput =
    user.role === "admin" ? { id } : { id, ownerId: user.id };
  const updated = await prisma.generationPreset.updateMany({
    where,
    data: {
      label: body.label,
      category: body.category,
      controls: body.controls ? toInputJson(body.controls) : undefined,
      visibility: body.visibility,
    },
  });
  if (updated.count === 0) throw Errors.notFound("Preset not found");
  const preset = await prisma.generationPreset.findUnique({ where: { id } });
  return ok({ preset });
}

async function listMedia(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const url = new URL(request.url);
  const liked = url.searchParams.get("liked") === "1";
  const type = url.searchParams.get("type");
  const assets = await prisma.mediaAsset.findMany({
    where: {
      ownerId: user.id,
      deletedAt: null,
      type: type ?? undefined,
      likes: liked ? { some: { userId: user.id } } : undefined,
    },
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 80, 40),
  });
  return ok({ items: assets.map(mediaDTO) });
}

async function likeMedia(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await assertMediaOwner(id, user.id);
  await prisma.mediaLike.upsert({
    where: { userId_mediaAssetId: { userId: user.id, mediaAssetId: id } },
    update: {},
    create: { userId: user.id, mediaAssetId: id },
  });
  await prisma.mediaAsset.update({ where: { id }, data: { liked: true } });
  return ok({ liked: true });
}

async function unlikeMedia(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.mediaLike.deleteMany({ where: { userId: user.id, mediaAssetId: id } });
  await prisma.mediaAsset.updateMany({ where: { id, ownerId: user.id }, data: { liked: false } });
  return ok({ liked: false });
}

async function bulkMedia(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = z
    .object({
      ids: z.array(z.string()).min(1).max(100),
      action: z.enum(["delete", "visibility"]),
      visibility: z.enum(["private", "public_pack", "unlisted"]).optional(),
    })
    .parse(await jsonBody(request));

  if (body.action === "delete") {
    await prisma.mediaAsset.updateMany({
      where: { id: { in: body.ids }, ownerId: user.id },
      data: { deletedAt: new Date() },
    });
    return ok({ deleted: body.ids.length });
  }

  await prisma.mediaAsset.updateMany({
    where: { id: { in: body.ids }, ownerId: user.id },
    data: { visibility: body.visibility ?? "private" },
  });
  return ok({ updated: body.ids.length });
}

async function downloadMedia(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const asset = await assertMediaOwner(id, user.id);
  const signed = await providers.blob.signGetUrl({
    key: asset.url,
    expiresInSeconds: 60 * 5,
  });
  return ok({ url: signed.ok ? signed.data.url : asset.url });
}

async function deleteMedia(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.mediaAsset.updateMany({
    where: { id, ownerId: user.id },
    data: { deletedAt: new Date() },
  });
  return ok({ deleted: true });
}

async function listPlans() {
  const plans = await prisma.plan.findMany({
    where: { active: true },
    orderBy: [{ slug: "asc" }, { billingPeriod: "asc" }],
  });
  return ok({ items: plans });
}

async function checkout(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = checkoutSchema.parse(await jsonBody(request));
  const plan = await findPlan(body);
  const invoice = await providers.payment.createInvoice({
    userId: user.id,
    amountCents: plan.priceCents,
    currency: plan.currency,
    metadata: { planId: plan.id },
  });
  if (!invoice.ok) throw Errors.internal(invoice.error.message, invoice.error);

  const checkoutSession = await prisma.checkoutSession.create({
    data: {
      userId: user.id,
      provider: invoice.data.provider,
      providerSessionId: invoice.data.invoiceId,
      returnPath: body.returnPath,
      status: body.autoConfirm ? "completed" : "created",
    },
  });

  let subscription = null;
  if (body.autoConfirm) {
    subscription = await activateSubscription(user.id, plan.id, invoice.data.invoiceId);
  }

  await trackEvent("checkout_started", { planId: plan.id, autoConfirm: body.autoConfirm }, ctx);
  return ok({
    checkout: checkoutSession,
    invoice: invoice.data,
    subscription,
  });
}

async function billingPortal(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  return ok({ url: `/profile?user=${user.id}#billing` });
}

async function billingWebhook(request: Request, provider: string) {
  const payload = await jsonBody(request);
  const eventId =
    request.headers.get("x-provider-event-id") ??
    (isRecord(payload) && typeof payload.providerEventId === "string"
      ? payload.providerEventId
      : cryptoRandomId("evt"));
  const parsed = await providers.payment.parseWebhook({
    providerEventId: eventId,
    payload,
    signature: request.headers.get("x-signature") ?? undefined,
  });
  if (!parsed.ok) throw Errors.badRequest(parsed.error.message, parsed.error);

  const already = await prisma.providerEvent.findUnique({
    where: { provider_providerEventId: { provider, providerEventId: eventId } },
  });
  if (already?.processedAt) return ok({ processed: false, idempotent: true });

  const event = await prisma.providerEvent.upsert({
    where: { provider_providerEventId: { provider, providerEventId: eventId } },
    update: { payload: toInputJson(payload) },
    create: {
      provider,
      providerEventId: eventId,
      type: parsed.data.type,
      payload: toInputJson(payload),
    },
  });
  const checkoutSession = await prisma.checkoutSession.findFirst({
    where: { providerSessionId: parsed.data.invoiceId },
  });
  if (checkoutSession) {
    const planId =
      isRecord(payload) && typeof payload.planId === "string" ? payload.planId : undefined;
    if (planId) await activateSubscription(checkoutSession.userId, planId, parsed.data.invoiceId);
    await prisma.checkoutSession.update({
      where: { id: checkoutSession.id },
      data: { status: "completed" },
    });
  }

  await prisma.providerEvent.update({
    where: { id: event.id },
    data: { processedAt: new Date() },
  });
  return ok({ processed: true });
}

async function dreamcoins(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const [balance, ledger] = await Promise.all([
    dreamcoinBalance(user.id),
    prisma.dreamcoinLedger.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return ok({ balance, ledger });
}

async function library(request: Request, tab: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);

  if (tab === "recent") {
    const sessions = await prisma.chatSession.findMany({
      where: { userId: user.id, status: { not: "deleted" } },
      include: { character: { include: { imageAsset: true, stats: true, tags: { include: { tag: true } } } } },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      take: 12,
    });
    return ok({ items: sessions });
  }

  if (tab === "characters") {
    const likes = await prisma.characterLike.findMany({
      where: { userId: user.id },
      include: { character: { include: characterInclude(user.id) } },
      orderBy: { createdAt: "desc" },
    });
    return ok({ items: likes.map((like) => characterDTO(like.character)) });
  }

  if (tab === "created") {
    const characters = await prisma.character.findMany({
      where: { creatorId: user.id, deletedAt: null },
      include: characterInclude(user.id),
      orderBy: { createdAt: "desc" },
    });
    return ok({ items: characters.map((character) => characterDTO(character)) });
  }

  if (tab === "presets") {
    const presets = await prisma.generationPreset.findMany({
      where: { ownerId: user.id, status: "active" },
      orderBy: { updatedAt: "desc" },
    });
    return ok({ items: presets });
  }

  if (tab === "media") return listMedia(request);
  if (tab === "group-chats" || tab === "packs") {
    return ok({ items: [], emptyCta: "/create" });
  }

  throw Errors.notFound("Library tab not found");
}

async function profile(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const [fullUser, balance, subscription, entitlements] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, include: { preferences: true } }),
    dreamcoinBalance(user.id),
    prisma.subscription.findFirst({
      where: { userId: user.id, status: "active" },
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    }),
    entitlementMap(user.id),
  ]);
  return ok({ user: fullUser, balance, subscription, entitlements });
}

async function updateProfile(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = profilePatchSchema.parse(await jsonBody(request));
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      displayName: body.displayName,
      name: body.displayName,
      image: body.image,
    },
  });
  return ok({ user: userDTO(updated) });
}

async function profilePreferences(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const preferences = await ensurePreferences(user.id);
  return ok({ preferences });
}

async function updatePreferences(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = preferencesPatchSchema.parse(await jsonBody(request));
  const preferences = await prisma.userPreferences.upsert({
    where: { userId: user.id },
    update: {
      locale: body.locale,
      mutedTags: body.mutedTags ? toInputJson(body.mutedTags) : undefined,
      safeModeFlags: body.safeModeFlags ? toInputJson(body.safeModeFlags) : undefined,
      notificationSettings: body.notificationSettings
        ? toInputJson(body.notificationSettings)
        : undefined,
    },
    create: {
      userId: user.id,
      locale: body.locale ?? "en",
      mutedTags: toInputJson(body.mutedTags ?? []),
      safeModeFlags: toInputJson(body.safeModeFlags ?? {}),
      notificationSettings: toInputJson(body.notificationSettings ?? {}),
    },
  });
  return ok({ preferences });
}

async function updateLanguage(request: Request) {
  const body = z.object({ locale: z.string().min(2).max(16) }).parse(await jsonBody(request));
  const nextRequest = new Request(request.url, {
    method: "PATCH",
    headers: request.headers,
    body: JSON.stringify({ locale: body.locale }),
  });
  return updatePreferences(nextRequest);
}

async function redeemCode(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = redeemSchema.parse(await jsonBody(request));
  const codeHash = simpleHash(body.code.toUpperCase());
  const code = await prisma.redeemCode.findUnique({ where: { codeHash } });
  if (!code || code.status !== "active" || (code.expiresAt && code.expiresAt < new Date())) {
    throw Errors.notFound("Redeem code not found");
  }
  const reward = isRecord(code.reward) ? code.reward : {};
  const coins = typeof reward.dreamcoins === "number" ? reward.dreamcoins : 100;

  // Reward exactly once per user — surface a graceful conflict on replay.
  const already = await prisma.redeemCodeRedemption.findUnique({
    where: { redeemCodeId_userId: { redeemCodeId: code.id, userId: user.id } },
  });
  if (already) throw Errors.conflict("Code already redeemed");

  const redemption = await prisma.$transaction(async (tx) => {
    const created = await tx.redeemCodeRedemption.create({
      data: { redeemCodeId: code.id, userId: user.id },
    });
    await appendLedger(tx, user.id, coins, "redeem", created.id);
    return created;
  });

  return ok({ redemption, dreamcoins: coins });
}

async function referrals(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const referrals = await prisma.referral.findMany({
    where: { inviterId: user.id },
    orderBy: { createdAt: "desc" },
  });
  return ok({ code: referralCode(user.id), referrals });
}

async function inviteReferral(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const referral = await prisma.referral.upsert({
    where: { code: referralCode(user.id) },
    update: {},
    create: {
      inviterId: user.id,
      code: referralCode(user.id),
    },
  });
  return ok({ referral, shareUrl: `/signup?ref=${referral.code}` });
}

async function signOutAll(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.session.deleteMany({ where: { userId: user.id } });
  const response = ok({ signedOut: true });
  response.headers.append("set-cookie", clearSessionCookie());
  return response;
}

async function deleteRequest(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.user.update({
    where: { id: user.id },
    data: { status: "deleted", deletedAt: new Date() },
  });
  await prisma.session.deleteMany({ where: { userId: user.id } });
  const response = ok({ requested: true });
  response.headers.append("set-cookie", clearSessionCookie());
  return response;
}

async function submitReport(
  request: Request,
  preset?: { targetType: string; targetId: string },
) {
  const ctx = await getAuthCtx(request);
  const body = reportSchema.partial({ targetType: true, targetId: true }).parse(await jsonBody(request));
  const targetType = preset?.targetType ?? body.targetType;
  const targetId = preset?.targetId ?? body.targetId;
  if (!targetType || !targetId || !body.category) {
    throw Errors.badRequest("targetType, targetId, and category are required");
  }
  const underage = body.category.includes("underage");
  const priority = underage ? 1 : 3;
  const report = await prisma.contentReport.create({
    data: {
      reporterId: ctx.userId,
      targetType,
      targetId,
      category: body.category,
      description: body.description,
      priority,
    },
  });
  await prisma.moderationEvent.create({
    data: {
      targetType,
      targetId,
      layer: "community_report",
      status: "flagged",
      policyCode: body.category,
      confidence: 1,
      details: { reportId: report.id },
    },
  });

  // Compliance (roadmap M9 / spec §4.4): underage reports are priority 1 and
  // immediately hide the target pending human review — over-hiding is the safe
  // failure mode for CSAM-adjacent reports.
  if (underage) {
    await applyModerationAction(targetType, targetId, body.category);
  }
  await jobQueue.enqueue({
    queue: "report.triage",
    payload: { reportId: report.id },
    priority,
    dedupeKey: `report.triage:${report.id}`,
  });
  await trackEvent("content_reported", { targetType, targetId, category: body.category }, ctx);
  return ok({ report });
}

async function reportStatus(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const report = await prisma.contentReport.findFirst({
    where: {
      id,
      OR: [{ reporterId: user.id }, { reporterId: null }],
    },
    include: { reviews: true },
  });
  if (!report) throw Errors.notFound("Report not found");
  return ok({ report });
}

async function createAppeal(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = z
    .object({
      targetType: z.string().min(1),
      targetId: z.string().min(1),
      appealText: z.string().min(1).max(4_000),
      originalDecisionId: z.string().optional(),
    })
    .parse(await jsonBody(request));
  const appeal = await prisma.appeal.create({
    data: { userId: user.id, ...body },
  });
  await trackEvent("moderation_appeal_started", { appealId: appeal.id }, ctx);
  return ok({ appeal });
}

async function policies() {
  const items = await prisma.policyVersion.findMany({
    orderBy: [{ slug: "asc" }, { publishedAt: "desc" }],
  });
  return ok({ items });
}

async function adminQueue(request: Request) {
  const ctx = await getAuthCtx(request);
  requireAdmin(ctx);
  const reports = await prisma.contentReport.findMany({
    where: { status: { in: ["open", "triaged", "reviewing"] } },
    include: { reviews: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: 100,
  });
  return ok({ reports });
}

async function adminDecision(request: Request, reportId: string) {
  const ctx = await getAuthCtx(request);
  const admin = requireAdmin(ctx);
  const body = adminDecisionSchema.parse(await jsonBody(request));
  const review = await prisma.moderationReview.create({
    data: {
      reportId,
      reviewerId: admin.id,
      decision: body.decision,
      policyCode: body.policyCode,
      notes: body.notes,
    },
  });
  const report = await prisma.contentReport.update({
    where: { id: reportId },
    data: { status: body.decision },
  });

  if (body.decision === "actioned") {
    await applyModerationAction(report.targetType, report.targetId, body.policyCode);
  }

  return ok({ review, report });
}

async function track(request: Request) {
  const ctx = await getAuthCtx(request);
  const body = eventSchema.parse(await jsonBody(request));
  const event = await trackEvent(body.name, body.props, ctx);
  return ok({ event });
}

async function feed(request: Request, segments: string[]) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const [, action, itemId, subAction] = segments;
  if (request.method === "GET") {
    const characters = await prisma.character.findMany({
      where: { visibility: "public", status: "approved", deletedAt: null },
      include: characterInclude(ctx.userId),
      orderBy: [{ stats: { chatsCount: "desc" } }],
      take: 20,
    });
    return ok({
      items: characters.map((character) => ({
        id: `character:${character.id}`,
        type: "character",
        character: characterDTO(character),
      })),
    });
  }
  if (request.method === "POST" && action === "restart") return ok({ cursor: null });
  if (request.method === "POST" && action === "items" && itemId && subAction === "share") {
    return ok({ shareUrl: `/feed?item=${itemId}` });
  }
  if (request.method === "POST" && action === "items" && itemId && subAction === "report") {
    return submitReport(request, { targetType: "feed_item", targetId: itemId });
  }
  return ok({ accepted: true });
}

async function community(request: Request, segments: string[]) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const [, view] = segments;

  if (view === "collections") {
    const collections = await prisma.mediaCollection.findMany({
      where: { visibility: "public" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return ok({ collections });
  }

  const characters = await prisma.character.findMany({
    where: { visibility: "public", status: "approved", deletedAt: null },
    include: characterInclude(ctx.userId),
    orderBy: [{ stats: { likesCount: "desc" } }],
    take: 20,
  });
  return ok({
    leaderboards: {
      characters: characters.map((character) => characterDTO(character)),
      dreamers: [],
      collections: [],
    },
  });
}

async function followUser(request: Request, targetId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  if (targetId === user.id) throw Errors.badRequest("Cannot follow yourself");
  const target = await prisma.user.findFirst({
    where: { id: targetId, status: "active", deletedAt: null },
  });
  if (!target) throw Errors.notFound("User not found");
  await prisma.follow.upsert({
    where: { followerId_followeeId: { followerId: user.id, followeeId: targetId } },
    update: {},
    create: { followerId: user.id, followeeId: targetId },
  });
  return ok({ following: true });
}

async function unfollowUser(request: Request, targetId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.follow.deleteMany({
    where: { followerId: user.id, followeeId: targetId },
  });
  return ok({ following: false });
}

async function duplicateCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const source = await readableCharacter(id, user.id);
  const duplicate = await prisma.character.create({
    data: {
      creatorId: user.id,
      name: `${source.name} Copy`,
      age: source.age,
      description: source.description,
      visibility: "private",
      status: "approved",
      style: source.style,
      gender: source.gender,
      relationship: source.relationship,
      imageAssetId: source.imageAssetId,
      appearance: toInputJson(source.appearance ?? {}),
      advancedDetails: toInputJson(source.advancedDetails ?? {}),
    },
  });
  await prisma.characterStats.create({ data: { characterId: duplicate.id } });
  return ok({ character: duplicate });
}

async function updateCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = z
    .object({
      name: z.string().min(1).max(80).optional(),
      description: z.string().min(1).max(1_500).optional(),
      visibility: z.enum(["private", "unlisted", "public"]).optional(),
    })
    .parse(await jsonBody(request));
  const character = await prisma.character.updateMany({
    where: { id, creatorId: user.id },
    data: {
      name: body.name,
      description: body.description,
      visibility: body.visibility,
      status: body.visibility === "public" ? "pending_review" : undefined,
    },
  });
  if (character.count === 0) throw Errors.notFound("Character not found");
  return getCharacter(request, id);
}

async function archiveCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.character.updateMany({
    where: { id, creatorId: user.id },
    data: { status: "archived", deletedAt: new Date() },
  });
  return ok({ archived: true });
}

function characterInclude(userId?: string) {
  return {
    imageAsset: true,
    stats: true,
    tags: { include: { tag: true } },
    likes: userId ? { where: { userId }, select: { userId: true } } : false,
  } satisfies Prisma.CharacterInclude;
}

type CharacterWithPublicRelations = Prisma.CharacterGetPayload<{
  include: ReturnType<typeof characterInclude>;
}>;

function characterDTO(character: CharacterWithPublicRelations) {
  return {
    id: character.id,
    name: character.name,
    title: character.name,
    age: String(character.age),
    description: character.description,
    visibility: character.visibility,
    status: character.status,
    style: character.style,
    gender: character.gender,
    relationship: character.relationship,
    creatorId: character.creatorId,
    creator: character.relationship ?? "@ourdream",
    image: character.imageAsset?.url ?? defaultImage,
    thumbnailUrl: character.imageAsset?.thumbnailUrl ?? character.imageAsset?.url ?? defaultImage,
    likes: formatCount(character.stats?.likesCount ?? 0),
    chats: formatCount(character.stats?.chatsCount ?? 0),
    views: character.stats?.viewsCount ?? 0,
    vivid: character.vivid,
    liked: Array.isArray(character.likes) ? character.likes.length > 0 : false,
    tags: character.tags.map(({ tag }) => tag),
    createdAt: character.createdAt,
  };
}

function userDTO(user: {
  id: string;
  email: string;
  displayName: string | null;
  name: string | null;
  image: string | null;
  role: string;
  status: string;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? user.name,
    image: user.image,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}

function mediaDTO(asset: {
  id: string;
  type: string;
  url: string;
  thumbnailUrl: string | null;
  prompt: string | null;
  visibility: string;
  safetyStatus: string;
  liked: boolean;
  createdAt: Date;
}) {
  return {
    id: asset.id,
    type: asset.type,
    url: asset.url,
    thumbnailUrl: asset.thumbnailUrl ?? asset.url,
    prompt: asset.prompt,
    visibility: asset.visibility,
    safetyStatus: asset.safetyStatus,
    liked: asset.liked,
    createdAt: asset.createdAt,
  };
}

async function jsonBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function parseRequestCookies(request: Request) {
  const header = request.headers.get("cookie");
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name) cookies.set(name, decodeURIComponent(value.join("=")));
  }
  return cookies;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function intParam(value: string | null) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampInt(value: string | null, min: number, max: number, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function encodeCursor(value: number) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | null) {
  if (!value) return 0;
  const decoded = Number.parseInt(Buffer.from(value, "base64url").toString("utf8"), 10);
  return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0;
}

function formatCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

async function assertDraftOwner(id: string, userId: string) {
  const draft = await prisma.characterDraft.findFirst({
    where: { id, ownerId: userId },
  });
  if (!draft) throw Errors.notFound("Character draft not found");
  return draft;
}

async function readableCharacter(id: string, userId: string) {
  const character = await prisma.character.findFirst({
    where: {
      id,
      deletedAt: null,
      OR: [
        { visibility: "public", status: "approved" },
        { creatorId: userId },
      ],
    },
  });
  if (!character) throw Errors.notFound("Character not found");
  return character;
}

async function assertMediaOwner(id: string, userId: string) {
  const media = await prisma.mediaAsset.findFirst({
    where: { id, ownerId: userId, deletedAt: null },
  });
  if (!media) throw Errors.notFound("Media not found");
  return media;
}

async function moderateText(
  targetType: string,
  targetId: string,
  content: string,
  layer: string,
) {
  const result = await providers.moderation.check({
    targetType: "text",
    content,
  });
  if (!result.ok) throw Errors.internal(result.error.message, result.error);

  await prisma.moderationEvent.create({
    data: {
      targetType,
      targetId,
      layer,
      status: result.data.status,
      policyCode: result.data.policyCode,
      confidence: result.data.confidence,
      details: {},
    },
  });

  return result.data;
}

async function currentAgeVerificationStatus(userId: string) {
  const latest = await prisma.ageVerification.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return latest?.status ?? "not_required";
}

async function dreamcoinBalance(userId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const aggregate = await tx.dreamcoinLedger.aggregate({
    where: { userId },
    _sum: { delta: true },
  });
  return aggregate._sum.delta ?? 0;
}

async function appendLedger(
  tx: Prisma.TransactionClient,
  userId: string,
  delta: number,
  reason: string,
  sourceId?: string,
) {
  const balance = await dreamcoinBalance(userId, tx);
  return tx.dreamcoinLedger.create({
    data: {
      userId,
      delta,
      balanceAfter: balance + delta,
      reason,
      sourceId,
    },
  });
}

async function refundGeneration(userId: string, jobId: string, cost: number) {
  await prisma.$transaction(async (tx) => {
    await appendLedger(tx, userId, cost, "refund", jobId);
    await tx.generationJob.update({
      where: { id: jobId },
      data: { status: "refunded" },
    });
  });
}

function generationCost(mode: "image" | "video", outputCount: number) {
  return mode === "video" ? 100 * outputCount : 10 * outputCount;
}

async function entitlementMap(userId: string) {
  const entitlements = await prisma.entitlement.findMany({
    where: {
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  const map: Record<string, Prisma.JsonValue> = {};
  for (const entitlement of entitlements) map[entitlement.key] = entitlement.value;
  return map;
}

async function findPlan(input: z.infer<typeof checkoutSchema>) {
  const plan = input.planId
    ? await prisma.plan.findUnique({ where: { id: input.planId } })
    : await prisma.plan.findUnique({
        where: {
          slug_billingPeriod: {
            slug: input.slug ?? "premium",
            billingPeriod: input.billingPeriod,
          },
        },
      });
  if (!plan || !plan.active) throw Errors.notFound("Plan not found");
  return plan;
}

async function activateSubscription(userId: string, planId: string, providerSubscriptionId: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
  const currentPeriodEnd = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      planId,
      provider: "mock",
      providerSubscriptionId,
      status: "active",
      currentPeriodEnd,
    },
  });
  await prisma.$transaction(async (tx) => {
    await tx.entitlement.upsert({
      where: { userId_key: { userId, key: "plan" } },
      update: { value: { slug: plan.slug, billingPeriod: plan.billingPeriod }, source: "subscription", expiresAt: currentPeriodEnd },
      create: { userId, key: "plan", value: { slug: plan.slug, billingPeriod: plan.billingPeriod }, source: "subscription", expiresAt: currentPeriodEnd },
    });
    const featureEntries = Object.entries(plan.features as JsonRecord);
    for (const [key, value] of featureEntries) {
      const entitlementValue = toInputJson(value ?? false);
      await tx.entitlement.upsert({
        where: { userId_key: { userId, key: featureKey(key) } },
        update: { value: entitlementValue, source: "subscription", expiresAt: currentPeriodEnd },
        create: { userId, key: featureKey(key), value: entitlementValue, source: "subscription", expiresAt: currentPeriodEnd },
      });
    }
    await tx.entitlement.upsert({
      where: { userId_key: { userId, key: "premium_controls" } },
      update: { value: true, source: "subscription", expiresAt: currentPeriodEnd },
      create: { userId, key: "premium_controls", value: true, source: "subscription", expiresAt: currentPeriodEnd },
    });
    await appendLedger(
      tx,
      userId,
      plan.includedDreamcoins,
      "subscription_grant",
      subscription.id,
    );
  });
  return subscription;
}

function featureKey(key: string) {
  return key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

async function imageUrlForCharacter(characterId?: string) {
  if (!characterId) return "/images/ourdream/promo-card-female.webp";
  const character = await prisma.character.findUnique({
    where: { id: characterId },
    include: { imageAsset: true },
  });
  return character?.imageAsset?.url ?? defaultImage;
}

async function incrementChatUsage(userId: string, sessionId: string) {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  await prisma.chatUsage.upsert({
    where: { userId_periodStart: { userId, periodStart } },
    update: { messagesUsed: { increment: 1 }, sessionId },
    create: { userId, sessionId, periodStart, periodEnd, messagesUsed: 1 },
  });
}

async function ensurePreferences(userId: string) {
  return prisma.userPreferences.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      mutedTags: [],
      safeModeFlags: {},
      notificationSettings: {},
    },
  });
}

async function applyModerationAction(
  targetType: string,
  targetId: string,
  policyCode?: string,
) {
  if (targetType === "character") {
    await prisma.character.updateMany({
      where: { id: targetId },
      data: { status: "removed" },
    });
  }
  if (targetType === "media") {
    await prisma.mediaAsset.updateMany({
      where: { id: targetId },
      data: { safetyStatus: "blocked" },
    });
  }
  await prisma.moderationEvent.create({
    data: {
      targetType,
      targetId,
      layer: "human_review",
      status: "blocked",
      policyCode,
      details: {},
    },
  });
}

async function trackEvent(
  name: string,
  props: unknown,
  ctx: { userId?: string; anonymousId?: string },
) {
  return prisma.analyticsEvent.create({
    data: {
      userId: ctx.userId,
      anonymousId: ctx.anonymousId,
      name,
      props: toInputJson(props),
    },
  });
}

function referralCode(userId: string) {
  return `DREAM-${userId.slice(-8).toUpperCase()}`;
}

function simpleHash(value: string) {
  let hash = 5381;
  for (const char of value) hash = (hash * 33) ^ char.charCodeAt(0);
  return `redeem_${Math.abs(hash)}`;
}

function cryptoRandomId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
