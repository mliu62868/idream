import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const exposureContextPayloadSchema = z.object({
  version: z.literal(1),
  subjectType: z.enum(["user", "anonymous"]),
  subjectId: z.string().min(1),
  characterId: z.string().min(1),
  characterContentVersionId: z.string().min(1),
  characterReleaseId: z.string().min(1),
  servingVersion: z.number().int().positive(),
  placementId: z.string().min(1),
  journeyId: z.string().min(1),
  impressionExposureId: z.string().min(1),
  detailExposureId: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict();

export type ExposureContextPayload = z.infer<typeof exposureContextPayloadSchema>;

export type ExposureSubject = {
  subjectType: "user" | "anonymous";
  subjectId: string;
};

// SPEC: 认证态优先，匿名态兜底，两者都没有则没有可归因的主体。
// INTENT: 曝光主体身份只在这里定一次 —— 发放侧（榜单）与核销侧（/track）必须得到
// 同一个答案，否则 assignment 归属校验会把合法请求判成"主体不匹配"。
export function metricExposureSubject(
  userId: string | null | undefined,
  anonymousId: string | null | undefined,
): ExposureSubject | null {
  if (userId) return { subjectType: "user", subjectId: userId };
  if (anonymousId) return { subjectType: "anonymous", subjectId: anonymousId };
  return null;
}

type IssueExposureContextInput = ExposureSubject & {
  characterId: string;
  characterContentVersionId: string;
  characterReleaseId: string;
  servingVersion: number;
  placementId: string;
  journeyId: string;
  now?: Date;
  ttlMs?: number;
};

export type IssuedExposureContext = {
  contextToken: string;
  journeyId: string;
  placementId: string;
  impressionExposureId: string;
  detailExposureId: string;
};

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1_000;
const JOURNEY_WINDOW_MS = 30 * 60 * 1_000;

// SPEC: 主站每个角色发现入口一个稳定 placementId；运营漏斗按它分组，改名等于断开历史。
export const EXPOSURE_PLACEMENTS = {
  exploreFeed: "explore.feed",
  exploreSearch: "explore.search",
  exploreFollowing: "explore.following",
  feedFeatured: "feed.featured",
  feedRecommended: "feed.recommended",
  feedShared: "feed.shared",
  searchSuggest: "search.suggest",
  creatorProfile: "creator.profile",
  communityLeaderboard: "community.leaderboard",
  chatHub: "chat.hub",
  guideStrip: "guide.strip",
  characterSimilar: "character.similar",
} as const;

function signature(secret: string, encodedPayload: string) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function keyedId(secret: string, parts: readonly string[]) {
  return createHmac("sha256", secret).update(JSON.stringify(parts)).digest("base64url").slice(0, 32);
}

// SPEC: 同一主体 30 分钟窗口内是同一 journey。
// INTENT: 发现列表会因切回标签页、返回上一页而重新拉取；journey 和下面的曝光 id
// 若每次随机，同一次浏览就会被数成多次曝光。确定性 id 让去重落在已有的
// sourceEventId / exposureId 幂等上，不需要新的去重存储。
export function exposureJourneyId(subject: ExposureSubject, secret: string, now = new Date()) {
  const window = Math.floor(now.getTime() / JOURNEY_WINDOW_MS);
  return `journey-${keyedId(secret, ["exposure-journey-v1", subject.subjectType, subject.subjectId, String(window)])}`;
}

export function issueExposureContext(
  input: IssueExposureContextInput,
  secret: string,
): IssuedExposureContext {
  const issuedAt = (input.now ?? new Date()).getTime();
  const exposureKey = [input.journeyId, input.characterId, input.placementId, input.characterReleaseId];
  const payload = exposureContextPayloadSchema.parse({
    version: 1,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    characterId: input.characterId,
    characterContentVersionId: input.characterContentVersionId,
    characterReleaseId: input.characterReleaseId,
    servingVersion: input.servingVersion,
    placementId: input.placementId,
    journeyId: input.journeyId,
    impressionExposureId: `character-impression-${keyedId(secret, ["exposure-impression-v1", ...exposureKey])}`,
    detailExposureId: `character-detail-${keyedId(secret, ["exposure-detail-v1", ...exposureKey])}`,
    issuedAt,
    expiresAt: issuedAt + (input.ttlMs ?? DEFAULT_TTL_MS),
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    contextToken: `${encodedPayload}.${signature(secret, encodedPayload)}`,
    journeyId: payload.journeyId,
    placementId: payload.placementId,
    impressionExposureId: payload.impressionExposureId,
    detailExposureId: payload.detailExposureId,
  };
}

type ExposureEligibleCharacter = {
  id: string;
  serving: {
    state: string;
    version: number;
    currentRelease: { id: string; status: string; characterContentVersionId: string } | null;
  } | null;
};

// SPEC: 一次发现响应的签发器。只给 live 且 Release 已发布的角色签发，其余返回 null。
// INVARIANT: 只读调用方已加载的 serving/currentRelease，不产生逐行查询。
export function discoveryExposureIssuer(subject: ExposureSubject | null, secret: string, now = new Date()) {
  const journeyId = subject ? exposureJourneyId(subject, secret, now) : null;
  return (character: ExposureEligibleCharacter, placementId: string): IssuedExposureContext | null => {
    const serving = character.serving;
    const release = serving?.state === "live" ? serving.currentRelease : null;
    if (!subject || !journeyId || !serving || release?.status !== "published") return null;
    return issueExposureContext({
      ...subject,
      characterId: character.id,
      characterContentVersionId: release.characterContentVersionId,
      characterReleaseId: release.id,
      servingVersion: serving.version,
      placementId,
      journeyId,
      now,
    }, secret);
  };
}

export function verifyExposureContext(
  token: string,
  subject: ExposureSubject,
  secret: string,
  now = new Date(),
): ExposureContextPayload | null {
  const [encodedPayload, suppliedSignature, extra] = token.split(".");
  if (!encodedPayload || !suppliedSignature || extra) return null;
  const expectedSignature = signature(secret, encodedPayload);
  const expected = Buffer.from(expectedSignature);
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  try {
    const payload = exposureContextPayloadSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    );
    if (payload.subjectType !== subject.subjectType || payload.subjectId !== subject.subjectId) return null;
    if (payload.expiresAt <= now.getTime() || payload.issuedAt > now.getTime() + 60_000) return null;
    return payload;
  } catch {
    return null;
  }
}
