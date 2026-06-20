import "dotenv/config";
import { defineConfig } from "prisma/config";

// Chat service connects with the chat_service role only. DATABASE_URL must point
// at that role (SELECT views + CRUD chat.*). DDL is owned by db/sql/*.sql, so we
// never migrate from here.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.CHAT_DATABASE_URL ?? process.env.DATABASE_URL,
  },
});
