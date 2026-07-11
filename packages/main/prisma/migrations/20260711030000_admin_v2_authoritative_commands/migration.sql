-- Creative Run optimistic concurrency requires a durable entity version.
ALTER TABLE "content_production_batches"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
