import { z } from "zod";
import * as adminContracts from "./contracts/index";
import type { AdminV2DeclaredRequestRef } from "./api-manifest";

/**
 * SPEC: 把 manifest 里声明的 contract ref（一个 schema 符号名）解析成可执行的 zod schema。
 * INTENT: 浏览器只需要 schema 查找；transport requirements 由服务端 registry 解释。
 *         正/负夹具由独立 testing 入口提供，不属于生产契约解析。
 * INTENT: 按名索引整个 barrel 意味着这条链路上的 admin 契约无法 tree-shake。这是有意的取舍：
 *         换来「manifest 声明什么、运行时就用什么解码」，中间没有第二份手配表可以配错。
 */
export type AdminV2ContractSchemas = typeof adminContracts;

type ContractBaseRef<Ref extends string> = Ref extends `${infer Base}+${string}` ? Base : Ref;
// Bound expansion to declared requests; schema defaults/coercion distinguish input from output.
type DeclaredRequestInputs = {
  [Name in ContractBaseRef<AdminV2DeclaredRequestRef>]: Name extends keyof AdminV2ContractSchemas
    ? AdminV2ContractSchemas[Name] extends z.ZodType ? z.input<AdminV2ContractSchemas[Name]> : never
    : never;
};
export type AdminV2RequestInput<Ref extends AdminV2DeclaredRequestRef> =
  DeclaredRequestInputs[ContractBaseRef<Ref>];

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
