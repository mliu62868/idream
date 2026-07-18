ALTER TABLE "control_plane_commands"
ADD COLUMN "coordinationKey" TEXT;

CREATE INDEX "control_plane_commands_coordinationKey_status_createdAt_idx"
ON "control_plane_commands"("coordinationKey", "status", "createdAt");
