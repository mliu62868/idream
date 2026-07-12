import { adminAuditEntrySchema } from "@idream/shared/admin";
import type { z } from "zod";

type AdminAuditRow = {
  readonly id: string;
  readonly actorId: string;
  readonly actorRole: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly requestId: string | null;
  readonly ipHash: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
};

export function adminAuditDto(row: AdminAuditRow): z.infer<typeof adminAuditEntrySchema> {
  return adminAuditEntrySchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
}
