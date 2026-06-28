// Chat service Prisma client — always Postgres, always the chat_service role.
// The pg driver adapter takes the connection string; no schema-side url (Prisma 7).
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client/client.js";

function connectionString(): string {
  const url = process.env.CHAT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("CHAT_DATABASE_URL (or DATABASE_URL) is required for chat service");
  return url;
}

const globalForChatPrisma = globalThis as unknown as { chatPrisma?: PrismaClient };

// Cap the pool in test: the chat test DB shares one Postgres instance (single
// max_connections) with main's test DB and any local dev/PM2 stack. An uncapped
// pool can cross the ceiling and cause flaky "too many clients" failures.
// Prod/dev keep the driver default; override with DATABASE_POOL_MAX.
function poolMax(): number | undefined {
  const override = process.env.DATABASE_POOL_MAX;
  if (override) {
    const parsed = Number.parseInt(override, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return process.env.NODE_ENV === "test" ? 5 : undefined;
}

export function createChatPrisma(): PrismaClient {
  const max = poolMax();
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString(), ...(max ? { max } : {}) }),
  });
}

export const chatPrisma: PrismaClient =
  globalForChatPrisma.chatPrisma ?? createChatPrisma();

if (process.env.NODE_ENV !== "production") {
  globalForChatPrisma.chatPrisma = chatPrisma;
}

export type { PrismaClient as ChatPrismaClient };
export type {
  ChatUserView,
  ChatCharacterView,
  ChatCharacterTagsView,
  ChatEntitlementView,
  ChatUserEligibilityView,
  ChatSession,
  Message,
  MessageVersion,
  ChatUsage,
  ChatOutboxEvent,
  ChatInboxEvent,
} from "../generated/client/client.js";
