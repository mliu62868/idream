import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";

// SPEC: GET/DELETE 请求没有 JSON body；其余方法把空 body 解释为空对象。
export async function jsonBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  return parseJsonText(await bodyText(request));
}

export async function bodyText(request: Request) {
  if (request.method === "GET" || request.method === "DELETE") return "";
  return request.text();
}

// INTENT: 非法 JSON 是客户端错误；原样抛 SyntaxError 会被当成 internal 返回 500 并污染错误日志。
export function parseJsonText(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw Errors.badRequest("Invalid JSON body");
  }
}

// INTENT: Prisma 的 JSON 输入类型比合法运行时 JSON 值更窄；调用方已在 schema 边界验证。
export function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
