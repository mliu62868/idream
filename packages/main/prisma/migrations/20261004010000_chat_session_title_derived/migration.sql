-- SPEC: recent_chats.title now stores only a name the user gave the chat; the
--       default title is derived from the Character's current name at read time.
-- INTENT: rows written before this change copied the Character name at creation,
--         so a renamed Character kept its old name in chat headers and lists.
--         Clear every one-to-one title that equals the Character's current name
--         or any name it carried in a saved content version; anything else was
--         typed by the user and is kept. Group member rows keep their speaker name.
UPDATE "recent_chats" AS rc
SET "title" = NULL
WHERE rc."groupId" IS NULL
  AND rc."title" IS NOT NULL
  AND (
    EXISTS (
      SELECT 1 FROM "characters" AS c
      WHERE c."id" = rc."characterId" AND c."name" = rc."title"
    )
    OR EXISTS (
      SELECT 1 FROM "character_content_versions" AS v
      WHERE v."characterId" = rc."characterId"
        AND rc."title" IN (
          v."personaSnapshot" -> 'soul' ->> 'name',
          v."personaSnapshot" -> 'soul' -> 'identity' ->> 'name'
        )
    )
  );
