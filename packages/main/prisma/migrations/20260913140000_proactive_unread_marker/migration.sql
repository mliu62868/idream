-- A proactive reply is the only chat message the user did not ask for in the
-- moment, so it is the only one that needs announcing in the session list.
-- NULL means nothing is waiting; the timestamp is when the Character spoke.
-- No dedicated index: the session list is already keyed by "userId".
ALTER TABLE "recent_chats" ADD COLUMN "proactiveUnreadAt" TIMESTAMP(3);
