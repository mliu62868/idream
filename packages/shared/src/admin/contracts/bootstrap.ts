import { z } from "zod";

export const adminShellSignalsSchema = z.object({
  environment: z.enum(["production", "staging", "local", "test", "unknown"]),
  dataClass: z.enum(["customer", "internal", "fixture", "audit", "unknown"]),
  fixtureState: z.enum(["included", "excluded", "unknown"]),
  productTimezone: z.string().min(1),
  freshness: z.discriminatedUnion("state", [
    z.object({ state: z.literal("reported"), label: z.string().min(1) }),
    z.object({
      state: z.literal("unavailable"),
      label: z.literal("No source watermark (legacy v1)"),
    }),
  ]),
});

export const adminBootstrapSchema = z.object({
  actor: z.object({ id: z.string().min(1), role: z.string().min(1) }).nullable(),
  permissions: z.array(z.string().min(1)),
  canReadDashboard: z.boolean(),
  devLogin: z.object({
    enabled: z.boolean(),
    accounts: z.array(z.object({
      username: z.string().min(1),
      password: z.string().min(1),
      label: z.string().min(1),
      role: z.enum(["user", "moderator", "support", "ops", "analyst", "admin"]),
    })),
  }),
  shellSignals: adminShellSignalsSchema,
});

export type AdminBootstrap = z.infer<typeof adminBootstrapSchema>;
