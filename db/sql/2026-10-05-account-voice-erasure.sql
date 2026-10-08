-- Apply Prisma migration 20261005010000_account_voice_erasure first.
-- This data repair does not own production DDL.

-- Repair only Admin-created dedicated copies for official profiles. Never
-- transfer an arbitrary user's source/reference upload to platform ownership.
UPDATE media_assets AS asset
SET "ownerId" = 'seed-system-creator',
    metadata = asset.metadata || '{"ownership":"platform_official"}'::jsonb
FROM character_voice_profiles AS profile, characters AS character
WHERE profile."characterId" = character.id
  AND character.source = 'official'
  AND asset."ownerId" = profile."createdById"
  AND asset."characterId" = character.id
  AND asset.metadata->>'providerVoiceId' = profile."providerVoiceId"
  AND (
    (asset.id = profile."referenceAssetId"
     AND asset.metadata->>'purpose' IN ('voice_clone_reference', 'voice_preset_reference')
     AND starts_with(asset."storageKey", 'voice-references/' || character.id || '/' || profile."providerVoiceId" || '.'))
    OR
    (asset.id = profile."previewAssetId"
     AND asset.metadata->>'purpose' IN ('voice_clone_preview', 'voice_preset_preview')
     AND asset."storageKey" = 'voice-previews/' || character.id || '/' || profile."providerVoiceId" || '.wav')
  )
  AND EXISTS (SELECT 1 FROM users WHERE id = 'seed-system-creator');
