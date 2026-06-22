-- Main DB migration (public schema) — RUN AS: the main DB owner (NOT chat_service).
-- Context: the chat service now owns chat sessions/messages/memory in its own
-- chat.* schema + file layer. main's monolith chat tables are dead code-side
-- (P1-4). This migration (1) adds the main-owned `recent_chats` read projection
-- that the library "recent" tab reads — fed by the chat→main outbox events in
-- src/processes/event-consumer.ts — and (2) drops the 6 now-dead monolith chat
-- tables. IDEMPOTENT. Canonical alternative: `DB_PROVIDER=postgresql prisma db
-- push` from packages/main reproduces exactly this (schema.prisma is the SSoT).
--
-- ⚠️ Destructive: the DROP TABLEs below remove monolith chat history that the
-- chat service does NOT use. Take a backup first if you want to retain it.

BEGIN;

-- 1. recent_chats read projection (matches the RecentChat Prisma model) --------
CREATE TABLE IF NOT EXISTS public.recent_chats (
    "sessionId"     TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "characterId"   TEXT NOT NULL,
    "title"         TEXT,
    "status"        TEXT NOT NULL DEFAULT 'active',     -- active | deleted
    "lastMessageAt" TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recent_chats_pkey" PRIMARY KEY ("sessionId")
);
CREATE INDEX IF NOT EXISTS "recent_chats_userId_lastMessageAt_idx"
    ON public.recent_chats ("userId", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "recent_chats_characterId_idx"
    ON public.recent_chats ("characterId");

-- FKs (cascade with the owning user/character). Guarded so the script is rerunnable.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recent_chats_userId_fkey') THEN
        ALTER TABLE public.recent_chats
            ADD CONSTRAINT "recent_chats_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES public.users ("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recent_chats_characterId_fkey') THEN
        ALTER TABLE public.recent_chats
            ADD CONSTRAINT "recent_chats_characterId_fkey"
            FOREIGN KEY ("characterId") REFERENCES public.characters ("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- 2. Drop the dead monolith chat tables (CASCADE clears their inter-FKs) -------
DROP TABLE IF EXISTS public.message_versions    CASCADE;
DROP TABLE IF EXISTS public.messages            CASCADE;
DROP TABLE IF EXISTS public.companion_memories  CASCADE;
DROP TABLE IF EXISTS public.relationship_states CASCADE;
DROP TABLE IF EXISTS public.chat_usage          CASCADE;
DROP TABLE IF EXISTS public.chat_sessions       CASCADE;

COMMIT;
