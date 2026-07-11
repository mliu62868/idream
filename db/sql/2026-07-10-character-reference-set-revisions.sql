-- Immutable character-identity reference snapshots used by generation jobs.
-- Apply once to the main PostgreSQL database before deploying the matching app code.
BEGIN;

CREATE TABLE public.reference_set_revisions (
  id text PRIMARY KEY,
  "visualProfileId" text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  "selectorVersion" text NOT NULL DEFAULT 'v1',
  "createdFrom" text NOT NULL,
  "availableAtSnapshot" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reference_set_revisions_visualProfileId_fkey"
    FOREIGN KEY ("visualProfileId") REFERENCES public.character_visual_profiles(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX "reference_set_revisions_visualProfileId_revision_key"
  ON public.reference_set_revisions ("visualProfileId", revision);
CREATE INDEX "reference_set_revisions_visualProfileId_status_idx"
  ON public.reference_set_revisions ("visualProfileId", status);

CREATE TABLE public.character_visual_reference_snapshots (
  id text PRIMARY KEY,
  "referenceSetRevisionId" text NOT NULL,
  "mediaAssetId" text NOT NULL,
  position integer NOT NULL,
  role text NOT NULL,
  weight double precision NOT NULL DEFAULT 1,
  crop jsonb,
  "qualityScore" double precision,
  "identityScore" double precision,
  "selectorVersion" text NOT NULL DEFAULT 'v1',
  "selectionReason" text NOT NULL,
  "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "character_visual_reference_snapshots_referenceSetRevisionId_fkey"
    FOREIGN KEY ("referenceSetRevisionId") REFERENCES public.reference_set_revisions(id) ON DELETE CASCADE,
  CONSTRAINT "character_visual_reference_snapshots_mediaAssetId_fkey"
    FOREIGN KEY ("mediaAssetId") REFERENCES public.media_assets(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "character_visual_reference_snapshots_referenceSetRevisionId_mediaAssetId_key"
  ON public.character_visual_reference_snapshots ("referenceSetRevisionId", "mediaAssetId");
CREATE INDEX "character_visual_reference_snapshots_mediaAssetId_idx"
  ON public.character_visual_reference_snapshots ("mediaAssetId");

CREATE TABLE public.reference_candidates (
  id text PRIMARY KEY,
  "visualProfileId" text NOT NULL,
  "mediaAssetId" text NOT NULL,
  "sourceJobId" text,
  "proposedRole" text NOT NULL DEFAULT 'identity_reference',
  "qualityScore" double precision,
  "identityScore" double precision,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'candidate',
  "rejectionReason" text,
  "promotedRevisionId" text,
  "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) without time zone NOT NULL,
  CONSTRAINT "reference_candidates_visualProfileId_fkey"
    FOREIGN KEY ("visualProfileId") REFERENCES public.character_visual_profiles(id) ON DELETE CASCADE,
  CONSTRAINT "reference_candidates_mediaAssetId_fkey"
    FOREIGN KEY ("mediaAssetId") REFERENCES public.media_assets(id) ON DELETE CASCADE,
  CONSTRAINT "reference_candidates_sourceJobId_fkey"
    FOREIGN KEY ("sourceJobId") REFERENCES public.generation_jobs(id) ON DELETE SET NULL,
  CONSTRAINT "reference_candidates_promotedRevisionId_fkey"
    FOREIGN KEY ("promotedRevisionId") REFERENCES public.reference_set_revisions(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX "reference_candidates_visualProfileId_mediaAssetId_key"
  ON public.reference_candidates ("visualProfileId", "mediaAssetId");
CREATE INDEX "reference_candidates_visualProfileId_status_idx"
  ON public.reference_candidates ("visualProfileId", status);
CREATE INDEX "reference_candidates_sourceJobId_idx" ON public.reference_candidates ("sourceJobId");
CREATE INDEX "reference_candidates_promotedRevisionId_idx"
  ON public.reference_candidates ("promotedRevisionId");

CREATE TABLE public.generation_feedback (
  id text PRIMARY KEY,
  "feedbackKey" text NOT NULL,
  "actorId" text NOT NULL,
  "mediaAssetId" text NOT NULL,
  "generationJobId" text NOT NULL,
  dimension text NOT NULL,
  value text NOT NULL,
  revision integer NOT NULL,
  "sourceSurface" text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  "supersedesId" text,
  "eventId" text NOT NULL,
  "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generation_feedback_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT "generation_feedback_mediaAssetId_fkey"
    FOREIGN KEY ("mediaAssetId") REFERENCES public.media_assets(id) ON DELETE CASCADE,
  CONSTRAINT "generation_feedback_generationJobId_fkey"
    FOREIGN KEY ("generationJobId") REFERENCES public.generation_jobs(id) ON DELETE CASCADE,
  CONSTRAINT "generation_feedback_supersedesId_fkey"
    FOREIGN KEY ("supersedesId") REFERENCES public.generation_feedback(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX "generation_feedback_eventId_key" ON public.generation_feedback ("eventId");
CREATE UNIQUE INDEX "generation_feedback_actorId_mediaAssetId_dimension_revision_key"
  ON public.generation_feedback ("actorId", "mediaAssetId", dimension, revision);
CREATE INDEX "generation_feedback_actorId_mediaAssetId_dimension_active_idx"
  ON public.generation_feedback ("actorId", "mediaAssetId", dimension, active);
CREATE INDEX "generation_feedback_generationJobId_createdAt_idx"
  ON public.generation_feedback ("generationJobId", "createdAt");

CREATE TABLE public.character_looks (
  id text PRIMARY KEY,
  "characterId" text NOT NULL,
  "visualProfileId" text NOT NULL,
  "ownerId" text NOT NULL,
  label text NOT NULL,
  "appearanceDelta" jsonb NOT NULL,
  "referenceAssetId" text,
  status text NOT NULL DEFAULT 'active',
  "activeKey" text,
  "rebasedFromLookId" text,
  "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) without time zone NOT NULL,
  CONSTRAINT "character_looks_characterId_fkey"
    FOREIGN KEY ("characterId") REFERENCES public.characters(id) ON DELETE CASCADE,
  CONSTRAINT "character_looks_visualProfileId_fkey"
    FOREIGN KEY ("visualProfileId") REFERENCES public.character_visual_profiles(id) ON DELETE RESTRICT,
  CONSTRAINT "character_looks_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT "character_looks_referenceAssetId_fkey"
    FOREIGN KEY ("referenceAssetId") REFERENCES public.media_assets(id) ON DELETE SET NULL,
  CONSTRAINT "character_looks_rebasedFromLookId_fkey"
    FOREIGN KEY ("rebasedFromLookId") REFERENCES public.character_looks(id) ON DELETE SET NULL
);

CREATE INDEX "character_looks_ownerId_characterId_status_idx"
  ON public.character_looks ("ownerId", "characterId", status);
CREATE INDEX "character_looks_visualProfileId_idx" ON public.character_looks ("visualProfileId");
CREATE INDEX "character_looks_referenceAssetId_idx" ON public.character_looks ("referenceAssetId");
CREATE UNIQUE INDEX "character_looks_activeKey_key" ON public.character_looks ("activeKey");

ALTER TABLE public.generation_jobs
  ADD COLUMN "referenceSetRevisionId" text,
  ADD COLUMN "referenceManifest" jsonb,
  ADD COLUMN "momentSpec" jsonb,
  ADD COLUMN "lookId" text,
  ADD COLUMN "lookSnapshot" jsonb,
  ADD CONSTRAINT "generation_jobs_referenceSetRevisionId_fkey"
    FOREIGN KEY ("referenceSetRevisionId") REFERENCES public.reference_set_revisions(id) ON DELETE SET NULL,
  ADD CONSTRAINT "generation_jobs_lookId_fkey"
    FOREIGN KEY ("lookId") REFERENCES public.character_looks(id) ON DELETE SET NULL;

CREATE INDEX "generation_jobs_referenceSetRevisionId_idx"
  ON public.generation_jobs ("referenceSetRevisionId");
CREATE INDEX "generation_jobs_lookId_idx" ON public.generation_jobs ("lookId");

COMMIT;
