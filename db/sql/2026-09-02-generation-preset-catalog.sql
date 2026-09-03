-- SPEC: Add useful built-in choices without overwriting operator edits,
-- including an intentional archive of a previously inserted entry.
BEGIN;
INSERT INTO generation_presets (id, scope, type, category, label, controls, visibility, status, "updatedAt")
VALUES
  ('seed-preset-background-rainy-cafe', 'built_in', 'background', 'Everyday', 'Rainy Café', '{"background": "a quiet cafe beside a rain-streaked window", "lighting": "warm interior lamps and soft window light"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-background-sunlit-garden', 'built_in', 'background', 'Outdoors', 'Sunlit Garden', '{"background": "a leafy garden path with flowering plants", "lighting": "soft late-afternoon daylight"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-background-city-evening', 'built_in', 'background', 'Evening', 'City Evening', '{"background": "a city street at blue hour with distant shop lights", "lighting": "gentle evening reflections"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-background-quiet-library', 'built_in', 'background', 'Everyday', 'Quiet Library', '{"background": "a reading corner with bookshelves and a wooden desk", "lighting": "warm reading lamp"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-pose-seated-portrait', 'built_in', 'pose', 'Studio', 'Seated Portrait', '{"pose": "seated comfortably with relaxed shoulders, looking toward the camera"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-pose-walking', 'built_in', 'pose', 'Outdoors', 'Walking', '{"pose": "walking naturally, caught mid-step in a candid moment"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-pose-over-shoulder', 'built_in', 'pose', 'Studio', 'Over the Shoulder', '{"pose": "turned slightly away, looking back over one shoulder"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-pose-relaxed-reading', 'built_in', 'pose', 'Everyday', 'Relaxed Reading', '{"pose": "sitting comfortably and reading an open book"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-outfit-knitwear', 'built_in', 'outfit', 'Everyday', 'Knitwear', '{"outfit": "a soft knitted sweater and simple everyday trousers"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-outfit-evening-dress', 'built_in', 'outfit', 'Evening', 'Evening Dress', '{"outfit": "an elegant evening dress with subtle accessories"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-outfit-athletic', 'built_in', 'outfit', 'Outdoors', 'Athletic', '{"outfit": "a fitted sports top, track pants and running shoes"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-outfit-tailored-suit', 'built_in', 'outfit', 'Studio', 'Tailored Suit', '{"outfit": "a tailored suit over a plain shirt"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-mode-editorial-photo', 'built_in', 'mode', 'Studio', 'Editorial Photo', '{"style": "editorial portrait photography, natural skin texture, restrained color grading"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-mode-cinematic', 'built_in', 'mode', 'Evening', 'Cinematic', '{"style": "cinematic composition, atmospheric lighting, subtle film color"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-mode-watercolor', 'built_in', 'mode', 'Illustration', 'Watercolor', '{"style": "watercolor illustration with soft pigment washes and visible paper texture"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP),
  ('seed-preset-mode-line-art', 'built_in', 'mode', 'Illustration', 'Line Art', '{"style": "clean expressive line illustration with restrained flat colors"}'::jsonb, 'public', 'active', CURRENT_TIMESTAMP)
ON CONFLICT (id) DO NOTHING;
COMMIT;
