-- Identity bootstrap commits a reviewed first portrait before the ordinary
-- qualification flow. The original constraint predates that authority state.
ALTER TABLE "character_visual_profiles"
  DROP CONSTRAINT IF EXISTS "character_visual_profile_evidence_state_check";

ALTER TABLE "character_visual_profiles"
  ADD CONSTRAINT "character_visual_profile_evidence_state_check"
  CHECK (
    "evidenceState" IN (
      'legacy_candidate',
      'candidate',
      'reviewed_bootstrap',
      'qualified',
      'stale'
    )
  );
