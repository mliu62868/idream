// SPEC: v1 后台 surface 的取/写快捷方式，薄薄一层盖在 `lib/admin-v2-api` 的信封解码之上。
// INTENT: 这里曾经是第二套 transport（自己的解码 + 自己的错误类）。保留这三个签名是因为
//         19 个后台 surface 在用它们，而它们本身除了「method 是哪一个」以外没有别的判断。
import { adminV2Request } from "@/lib/admin-v2-api";

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
export function apiWrite<T>(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<T> {
  return adminV2Request<T>(path, { method, body, ...(headers ? { headers } : {}) });
}

export function apiDelete<T>(
  path: string,
  headers?: Record<string, string>,
): Promise<T> {
  return adminV2Request<T>(path, { method: "DELETE", ...(headers ? { headers } : {}) });
}
