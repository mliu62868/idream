-- Drop the shadow reference columns on CharacterVisualProfile.
-- The single authority for "which images are this character's references" is
-- ReferenceSetRevision + CharacterVisualReferenceSnapshot: the paid generation path
-- (service.ts referenceAuthority) reads ONLY that pair and derives anchors from
-- snapshot.role, never from these columns. They are shadow copies kept in sync by
-- scattered code — dev measurement 2026-07-25: 9 profiles, 8 identical, 1 drifted.
--
-- PREREQUISITE: all 65 production read sites must already go through
-- characterReferenceAuthority() — see
-- docs/superpowers/specs/2026-07-25-visual-reference-single-authority-design.md.
-- Running this before the code change WILL break generation.
--
-- ORDER (DROP column = zero-window): build → restart → run this SQL.
-- The new client's model has no such column, so its SELECTs never reference it.
-- Run ONCE per database (dev, then prod).
-- NOTE: only referenceAssetIds is a shadow copy. anchorAssetIds is the *candidate pool*
-- (it may hold images outside the current reference set — dropping it would make it
-- impossible to add new images to a reference set). It can only be dropped after the pool
-- moves to ReferenceCandidate; see §2.1 of the design doc.
BEGIN;
ALTER TABLE public.character_visual_profiles DROP COLUMN "referenceAssetIds";
COMMIT;
