import { createHash, randomUUID } from "node:crypto";

// SPEC: 从入站 Request 里取出 Audit 行需要的三个请求身份字段。
// INTENT: v1 的 `adminAuditData` 把「取身份」和「拼整行」焊在一起，于是任何想自己控制
// before/after 形状的写操作都得连带接受它那套。这里只留取身份的部分，Audit 行由各领域
// 自己按 v2 惯例写（见 today/claim.ts），两件事不再互相绑架。
export function adminRequestId(request: Request) {
  return request.headers.get("x-request-id")?.trim() || randomUUID();
}

export function adminRequestIpHash(request: Request) {
  const value = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip");
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function adminRequestUserAgent(request: Request) {
  return request.headers.get("user-agent") ?? undefined;
}
