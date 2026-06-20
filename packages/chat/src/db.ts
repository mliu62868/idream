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

export function createChatPrisma(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString() }) });
}

export const chatPrisma: PrismaClient =
  globalForChatPrisma.chatPrisma ?? createChatPrisma();

if (process.env.NODE_ENV !== "production") {
  globalForChatPrisma.chatPrisma = chatPrisma;
}

export type { PrismaClient as ChatPrismaClient };
