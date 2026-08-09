import { z } from "zod";
import * as adminContracts from "./contracts/index";

/**
 * SPEC: 把 manifest 里声明的 contract ref（一个 schema 符号名）解析成可执行的 zod schema。
 * INTENT: 从 contract-registry 里分出来，是因为客户端只需要这一步。registry 还会为每个契约
 *         生成正/负夹具（几百行反射式构造），那是契约测试的需要，不该跟着解码器进浏览器包。
 * INTENT: 按名索引整个 barrel 意味着这条链路上的 admin 契约无法 tree-shake。这是有意的取舍：
 *         换来「manifest 声明什么、运行时就用什么解码」，中间没有第二份手配表可以配错。
 */
export type AdminV2ContractSchemas = typeof adminContracts;

export type AdminV2ContractSchemaFor<Ref extends string> =
  Ref extends keyof AdminV2ContractSchemas
    ? AdminV2ContractSchemas[Ref] extends z.ZodType
      ? AdminV2ContractSchemas[Ref]
      : never
    : never;

export function adminV2ContractSchema(ref: string): z.ZodType | null {
  const candidate = adminContracts[ref as keyof AdminV2ContractSchemas] as unknown;
  return isZodSchema(candidate) ? candidate : null;
}

export function requireAdminV2ContractSchema(ref: string): z.ZodType {
  const schema = adminV2ContractSchema(ref);
  if (!schema) throw new Error(`Admin v2 contract ${ref} has no executable schema`);
  return schema;
}

function isZodSchema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "safeParse" in value &&
    typeof (value as { safeParse?: unknown }).safeParse === "function";
}
