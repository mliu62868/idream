// SPEC: v1 后台 surface 的取/写快捷方式，薄薄一层盖在 `lib/admin-v2-api` 的信封解码之上。
// INTENT: 这里曾经是第二套 transport（自己的解码 + 自己的错误类）。保留这三个签名是因为
//         19 个后台 surface 在用它们，而它们本身除了「method 是哪一个」以外没有别的判断。
import { AdminV2RequestError, adminV2Request } from "@/lib/admin-v2-api";
import {
  adminIdempotencyKeyLedger,
  idempotencyOutcomeOfStatus,
} from "@/lib/idempotency-key-lifecycle";

export {
  AdminV2RequestError,
  formatApiError,
  type ApiEnvelope,
  type ApiError,
} from "@/lib/admin-v2-api";

export function apiGet<T>(path: string): Promise<T> {
  return adminV2Request<T>(path);
}

// DELETE 也在这里而不是 apiDelete：撤销类命令同样要带 reason + confirmation 的 body，
// 而 apiDelete 是给「路径本身就是全部意图」的删除用的。
//
// SPEC: 每一次写都带幂等键，键由 `idempotency-key-lifecycle` 的账本生成、复用和回收。
// INTENT: 调用方以前把键当成第四个参数 —— 一个 `headers` 口袋 —— 自己塞
//         `{ "idempotency-key": crypto.randomUUID() }` 进去。全仓 47 处里有 17 处是「每次
//         点击造一把新键」：丢响应后重试就是第二次真实写入。键不再经过调用方之后，那 17 处
//         连表达的位置都没有了。服务端只在 manifest 声明了 `+idempotency-key` 时才校验这个
//         头，多带一个是无害的，所以不必在这一层区分端点。
export function apiWrite<T>(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body: Record<string, unknown>,
): Promise<T> {
  return idempotentWrite<T>(path, method, { body });
}

export function apiDelete<T>(path: string): Promise<T> {
  return idempotentWrite<T>(path, "DELETE", {});
}

async function idempotentWrite<T>(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  options: { body?: Record<string, unknown> },
): Promise<T> {
  const scope = `${method} ${path}`;
  const key = adminIdempotencyKeyLedger.claim(scope, JSON.stringify(options.body ?? null));
  try {
    const result = await adminV2Request<T>(path, { method, ...options, idempotencyKey: key });
    adminIdempotencyKeyLedger.settle(scope, key, "answered");
    return result;
  } catch (error) {
    adminIdempotencyKeyLedger.settle(
      scope,
      key,
      idempotencyOutcomeOfStatus(
        error instanceof AdminV2RequestError ? error.status : undefined,
      ),
    );
    throw error;
  }
}
