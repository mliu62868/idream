-- Drop the shadow reference columns on CharacterVisualProfile.
-- The single authority for "which images are this character's references" is
-- ReferenceSetRevision + CharacterVisualReferenceSnapshot: the paid generation path
-- (service.ts referenceAuthority) reads ONLY that pair and derives anchors from
-- snapshot.role, never from these columns. They are shadow copies kept in sync by
-- scattered code — dev measurement 2026-07-25: 9 profiles, 8 identical, 1 drifted.
--
-- PREREQUISITE: all reference read sites must already go through
-- characterReferenceAuthority() — see
-- docs/architecture/16-character-asset-studio-authority.md.
-- Running this before the code change WILL break generation.
--
-- ORDER (DROP column = zero-window): build → restart → run this SQL.
-- The new client's model has no such column, so its SELECTs never reference it.
-- Run ONCE per database (dev, then prod).
-- NOTE: this migration drops only referenceAssetIds, not anchorAssetIds.
-- Current candidate selection uses the same-character image library in
-- workspace-visual.ts/reference-set.ts; active reference revision is separate.
-- This historical one-time migration does not change that selection workflow.
BEGIN;
ALTER TABLE public.character_visual_profiles DROP COLUMN "referenceAssetIds";
COMMIT;
