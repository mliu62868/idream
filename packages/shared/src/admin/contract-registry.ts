import { z } from "zod";
import { adminV2ContractSchema } from "./contract-schemas";

export type ExecutableAdminV2Contract = {
  readonly kind: "zod" | "transport";
  readonly ref: string;
  readonly schema: z.ZodType;
  readonly source: `packages/${string}`;
  readonly requirements: readonly ("idempotency-key" | "if-match")[];
};

const transportContracts = {
  none: z.undefined(),
  "path:id": z.object({ id: z.string().trim().min(1) }).strict(),
  "path:commandId": z.object({ commandId: z.string().trim().min(1) }).strict(),
  "if-match": z
    .object({ ifMatch: z.coerce.number().int().positive() })
    .strict(),
  "limit-query": z
    .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
    .strict(),
} as const satisfies Record<string, z.ZodType>;


export function resolveAdminV2Contract(ref: string): ExecutableAdminV2Contract | null {
  const [baseRef, ...suffixes] = ref.split("+");
  const requirements = suffixes.filter(
    (part): part is "idempotency-key" | "if-match" =>
      part === "idempotency-key" || part === "if-match",
  );
  const transport = transportContracts[baseRef as keyof typeof transportContracts];
  const schema = transport ?? adminV2ContractSchema(baseRef);
  if (!schema) return null;
  return {
    kind: transport ? "transport" : "zod",
    ref: baseRef,
    schema,
    requirements,
    source: transport
      ? "packages/shared/src/admin/contract-registry.ts"
      : `packages/shared/src/admin/contracts/index.ts#${baseRef}`,
  };
}

export function requireExecutableAdminV2Contract(ref: string): ExecutableAdminV2Contract {
  const binding = resolveAdminV2Contract(ref);
  if (!binding) throw new Error(`Admin v2 contract ${ref} is not executable`);
  return binding;
}
