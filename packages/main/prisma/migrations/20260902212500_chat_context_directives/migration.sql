-- Explicit user-authored settings; no automatic memory cache or historical Turn rewrite.
CREATE TABLE "chat_context_directives" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chat_context_directives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chat_context_directives_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "chat_context_directives_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "chat_context_directives_kind_check" CHECK ("kind" IN ('pinned_memory', 'custom_instruction')),
  CONSTRAINT "chat_context_directives_version_check" CHECK ("version" > 0),
  CONSTRAINT "chat_context_directives_content_check" CHECK (
    ("status" = 'archived' AND "content" = '') OR
    ("status" = 'active' AND char_length(btrim("content")) > 0 AND char_length("content") <= CASE WHEN "kind" = 'pinned_memory' THEN 500 ELSE 1500 END)
  )
);
CREATE INDEX "chat_context_directives_userId_characterId_status_idx" ON "chat_context_directives"("userId", "characterId", "status");
CREATE UNIQUE INDEX "chat_context_directives_one_active_instruction" ON "chat_context_directives"("userId", "characterId") WHERE "kind" = 'custom_instruction' AND "status" = 'active';
