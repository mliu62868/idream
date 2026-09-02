import { z } from "zod";

export const CHAT_RUNTIME_DIAGNOSTICS_PATH = "/internal/admin/runtime-diagnostics" as const;

export const chatRuntimeDiagnosticsSchema = z.object({
  version: z.literal(1),
  service: z.literal("chat"),
  checkedAt: z.string().datetime({ offset: true }),
  sourceRevision: z.string().min(1).nullable(),
  runtime: z.object({
    accepting: z.boolean(),
    warmed: z.boolean(),
    fileStore: z.boolean(),
    redis: z.boolean(),
    agentRuntime: z.boolean(),
    fresh: z.boolean(),
    observedAt: z.string().datetime({ offset: true }).nullable(),
    reason: z.string().nullable(),
  }).strict(),
  provider: z.object({
    adapter: z.string().min(1),
    model: z.string().min(1),
    endpoint: z.string().min(1).nullable(),
  }).strict(),
}).strict();

export type ChatRuntimeDiagnostics = z.infer<typeof chatRuntimeDiagnosticsSchema>;
