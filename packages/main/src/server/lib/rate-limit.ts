import IORedis from "ioredis";
import { redisConnectionOptions } from "@idream/shared/env";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * SPEC: 用户侧写入端点的固定窗口限流。
 *
 * INTENT: 这里只保护「便宜、可自动重复、且失败无代价」的端点 —— 登录爆破、
 * 兑换码枚举、举报灌库、匿名埋点写入。生成类端点已有各自的在途并发闸
 * (generation-job-create / generation-job-retry)，不重复施加。
 *
 * INVARIANT: Redis 不可用时 fail-open。限流是纵深防御，不是可用性依赖 ——
 * 让 Redis 故障把全站登录打死，比被限流保护的那个风险更糟。降级会打日志。
 */

export interface RateLimitPolicy {
  /** 窗口内允许的请求数 */
  readonly limit: number;
  /** 窗口长度（毫秒） */
  readonly windowMs: number;
}

export const RATE_LIMITS = {
  // 登录：实测改前 8 次错误密码 27ms/次、无退避。
  authLogin: { limit: 10, windowMs: 5 * 60_000 },
  // 注册：免费账号是多个滥用路径的入场券，收得比登录更紧。
  authSignup: { limit: 5, windowMs: 60 * 60_000 },
  // 兑换码：码空间小且哈希弱，枚举收益高。
  redeemCode: { limit: 10, windowMs: 60 * 60_000 },
  // 举报：匿名可提交，无去重，会无界产生审核 Case。
  contentReport: { limit: 20, windowMs: 60 * 60_000 },
  // 埋点：匿名开放写，正常用户一次会话也会打不少，阈值放宽但不能无界。
  eventTrack: { limit: 300, windowMs: 60 * 60_000 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitScope = keyof typeof RATE_LIMITS;

let client: IORedis | null = null;
let clientUnavailable = false;

function redis(): IORedis | null {
  if (clientUnavailable) return null;
  if (client) return client;
  try {
    const connection = new IORedis({
      ...redisConnectionOptions(env.REDIS_URL),
      // 限流在请求热路径上：宁可放行也不要挂住请求。offlineQueue 留着，
      // 这样「连接建立中」不会被误判成「Redis 挂了」；真正的不可用由
      // commandTimeout 兜住，超时即 fail-open。
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
      commandTimeout: 200,
      lazyConnect: false,
    });
    connection.on("error", (error) => {
      logger.warn({ err: error }, "rate limiter redis error; failing open");
    });
    client = connection;
    return client;
  } catch (error) {
    clientUnavailable = true;
    logger.warn({ err: error }, "rate limiter redis unavailable; failing open");
    return null;
  }
}

/**
 * INTENT: 单元/集成测试直接调 dispatchV1，所有请求共享同一个「无 IP」身份，
 * 开着限流会让不相关的用例互相打架。默认在 test 关闭，需要验证限流本身的
 * 用例用 RATE_LIMIT_FORCE=1 显式打开。
 */
function enabled(): boolean {
  if (process.env.RATE_LIMIT_FORCE === "1") return true;
  if (process.env.RATE_LIMIT_DISABLED === "1") return false;
  return env.APP_ENV !== "test";
}

/**
 * 限流身份。已登录用户按 userId，匿名按可信代理传来的客户端 IP。
 *
 * INVARIANT: 只认反代注入的头。生产必须让入口反代覆盖 x-forwarded-for，
 * 否则匿名请求会退化成共享一个桶 —— 那是保守方向的失败，可接受。
 */
export function rateLimitIdentity(
  request: Request,
  userId: string | undefined,
): string {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return `ip:${first}`;
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return `ip:${real}`;
  return "ip:unknown";
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly count: number;
  readonly limit: number;
  readonly retryAfterMs: number;
}

/** 消费一次配额并返回判定；Redis 不可用时恒放行。 */
export async function consumeRateLimit(
  scope: RateLimitScope,
  identity: string,
): Promise<RateLimitDecision> {
  const policy = RATE_LIMITS[scope];
  if (!enabled()) {
    return { allowed: true, count: 0, limit: policy.limit, retryAfterMs: 0 };
  }
  const connection = redis();
  if (!connection) {
    return { allowed: true, count: 0, limit: policy.limit, retryAfterMs: 0 };
  }

  const window = Math.floor(Date.now() / policy.windowMs);
  const key = `${env.BULLMQ_PREFIX}:ratelimit:${scope}:${identity}:${window}`;
  try {
    const count = await connection.incr(key);
    if (count === 1) await connection.pexpire(key, policy.windowMs);
    const retryAfterMs =
      (window + 1) * policy.windowMs - Date.now();
    return {
      allowed: count <= policy.limit,
      count,
      limit: policy.limit,
      retryAfterMs: Math.max(0, retryAfterMs),
    };
  } catch (error) {
    logger.warn({ err: error, scope }, "rate limiter unavailable; failing open");
    return { allowed: true, count: 0, limit: policy.limit, retryAfterMs: 0 };
  }
}

/** 超限直接抛 429；调用点放在 handler 之前，避免为被拒请求做任何工作。 */
export async function enforceRateLimit(
  request: Request,
  scope: RateLimitScope,
  userId?: string,
): Promise<void> {
  const identity = rateLimitIdentity(request, userId);
  const decision = await consumeRateLimit(scope, identity);
  if (decision.allowed) return;
  logger.warn(
    { scope, identity, count: decision.count, limit: decision.limit },
    "rate limit exceeded",
  );
  throw Errors.rateLimited("Too many requests; slow down and try again", {
    scope,
    limit: decision.limit,
    retryAfterMs: decision.retryAfterMs,
  });
}
