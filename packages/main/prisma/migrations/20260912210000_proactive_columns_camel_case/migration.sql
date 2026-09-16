-- 20260912080000_proactive_messages 用下划线列名建了三个字段，而 recent_chats 其余所有列
-- 都是驼峰，Prisma schema 也按驼峰声明且没有 @map。后果是任何整行读取直接失败：
--   The column `t0.proactiveEnabled` does not exist in the current database.
-- 这里把列名收敛回表自身的约定，而不是给 schema 补 @map 去迁就一次手写迁移。
ALTER TABLE "recent_chats" RENAME COLUMN "proactive_enabled" TO "proactiveEnabled";
ALTER TABLE "recent_chats" RENAME COLUMN "proactive_interval_hours" TO "proactiveIntervalHours";
ALTER TABLE "recent_chats" RENAME COLUMN "proactive_next_at" TO "proactiveNextAt";

ALTER TABLE "recent_chats" RENAME CONSTRAINT "recent_chats_proactive_interval_hours_check"
  TO "recent_chats_proactiveIntervalHours_check";
ALTER INDEX "recent_chats_proactive_due_idx" RENAME TO "recent_chats_proactiveDue_idx";
