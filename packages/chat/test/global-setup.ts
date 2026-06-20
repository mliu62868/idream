// Provision the chat test DB once per run (Postgres-only — chat is PG-native).
// If Postgres is unreachable, fail loudly: the boundary tests are the whole point
// of P0-1 and silently skipping would hide a broken split.
import { provisionChatTestDb } from "./provision.mjs";

export default async function setup() {
  const { chatServiceUrl } = provisionChatTestDb();
  process.env.CHAT_DATABASE_URL = chatServiceUrl;
}
