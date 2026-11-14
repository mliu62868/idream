ALTER TABLE "chat_turns"
ADD COLUMN "imageActionMode" TEXT NOT NULL DEFAULT 'chat',
ADD CONSTRAINT "chat_turns_image_action_mode_check"
CHECK ("imageActionMode" IN ('chat', 'paid', 'library'));
