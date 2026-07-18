-- Preserve every existing RoutePage row and body while separating template,
-- publication, and search-distribution authority.
ALTER TABLE "route_pages"
  ADD COLUMN "contentSchemaVersion" INTEGER,
  ADD COLUMN "indexingStatus" TEXT NOT NULL DEFAULT 'noindex',
  ADD COLUMN "publishedAt" TIMESTAMP(3);

-- Preserve legacy publications only when their stored JSON already satisfies
-- the v1 article contract. They remain noindex until an operator explicitly
-- reviews distribution settings. This avoids both silent mass-unpublishing and
-- serving structurally invalid legacy bodies.
WITH "eligible_legacy_publications" AS (
  SELECT page."path"
  FROM "route_pages" AS page
  WHERE
    page."contentStatus" = 'published'
    AND page."template" = 'article'
    AND page."path" ~ '^/[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$'
    AND page."path" !~ '^/(admin|api|characters|chat|community|create|creators|custom|explore|feed|generate|generator|helpdesk|internal-preview|login|profile|safety|signup|terms|upgrade|user-content)(/|$)'
    AND char_length(btrim(page."title")) BETWEEN 10 AND 200
    AND char_length(btrim(page."description")) BETWEEN 50 AND 320
    AND (
      page."canonical" IS NULL
      OR page."canonical" = '/'
      OR page."canonical" ~ '^/[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$'
    )
    AND jsonb_typeof(page."body") = 'object'
    AND octet_length(page."body"::text) <= 131072
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys(
        CASE
          WHEN jsonb_typeof(page."body") = 'object' THEN page."body"
          ELSE '{}'::jsonb
        END
      ) AS body_key
      WHERE body_key NOT IN ('heading', 'intro', 'sections', 'cta')
    )
    AND jsonb_typeof(page."body"->'heading') = 'string'
    AND char_length(btrim(page."body"->>'heading')) BETWEEN 1 AND 160
    AND jsonb_typeof(page."body"->'intro') = 'string'
    AND char_length(btrim(page."body"->>'intro')) BETWEEN 60 AND 2000
    AND jsonb_typeof(page."body"->'sections') = 'array'
    AND jsonb_array_length(
      CASE
        WHEN jsonb_typeof(page."body"->'sections') = 'array'
          THEN page."body"->'sections'
        ELSE '[]'::jsonb
      END
    ) BETWEEN 2 AND 30
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(page."body"->'sections') = 'array'
            THEN page."body"->'sections'
          ELSE '[]'::jsonb
        END
      ) AS section
      WHERE
        jsonb_typeof(section) <> 'object'
        OR EXISTS (
          SELECT 1
          FROM jsonb_object_keys(
            CASE
              WHEN jsonb_typeof(section) = 'object' THEN section
              ELSE '{}'::jsonb
            END
          ) AS section_key
          WHERE section_key NOT IN ('heading', 'paragraphs')
        )
        OR jsonb_typeof(section->'heading') <> 'string'
        OR char_length(btrim(section->>'heading')) NOT BETWEEN 1 AND 160
        OR jsonb_typeof(section->'paragraphs') <> 'array'
        OR jsonb_array_length(
          CASE
            WHEN jsonb_typeof(section->'paragraphs') = 'array'
              THEN section->'paragraphs'
            ELSE '[]'::jsonb
          END
        ) NOT BETWEEN 1 AND 20
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(section->'paragraphs') = 'array'
                THEN section->'paragraphs'
              ELSE '[]'::jsonb
            END
          ) AS paragraph
          WHERE
            jsonb_typeof(paragraph) <> 'string'
            OR char_length(btrim(paragraph #>> '{}')) NOT BETWEEN 40 AND 4000
        )
    )
    AND (
      SELECT count(*) = count(DISTINCT lower(btrim(section->>'heading')))
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(page."body"->'sections') = 'array'
            THEN page."body"->'sections'
          ELSE '[]'::jsonb
        END
      ) AS section
    )
    AND (
      NOT (page."body" ? 'cta')
      OR (
        jsonb_typeof(page."body"->'cta') = 'object'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_object_keys(
            CASE
              WHEN jsonb_typeof(page."body"->'cta') = 'object'
                THEN page."body"->'cta'
              ELSE '{}'::jsonb
            END
          ) AS cta_key
          WHERE cta_key NOT IN ('label', 'href')
        )
        AND jsonb_typeof(page."body"->'cta'->'label') = 'string'
        AND char_length(btrim(page."body"->'cta'->>'label')) BETWEEN 1 AND 80
        AND jsonb_typeof(page."body"->'cta'->'href') = 'string'
        AND char_length(btrim(page."body"->'cta'->>'href')) BETWEEN 1 AND 2048
        AND (
          page."body"->'cta'->>'href' = '/'
          OR page."body"->'cta'->>'href' ~ '^/[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$'
          OR page."body"->'cta'->>'href' ~ '^https://[^/[:space:]]+(/[^[:space:]]*)?$'
        )
      )
    )
)
UPDATE "route_pages"
SET
  "contentSchemaVersion" = 1,
  -- This migration is the first v1 contract qualification event. Do not
  -- misrepresent an arbitrary legacy edit timestamp as the publish time.
  "publishedAt" = CURRENT_TIMESTAMP,
  "indexingStatus" = 'noindex'
WHERE "path" IN (SELECT "path" FROM "eligible_legacy_publications");

-- Invalid legacy publications are retained intact as editable noindex drafts.
UPDATE "route_pages"
SET
  "contentStatus" = 'draft',
  "contentSchemaVersion" = NULL,
  "indexingStatus" = 'noindex',
  "publishedAt" = NULL
WHERE
  "contentStatus" = 'published'
  AND "contentSchemaVersion" IS DISTINCT FROM 1;

-- Preserve unexpected legacy rows instead of failing the constraint addition;
-- unknown states have no serving authority and become reviewable drafts.
UPDATE "route_pages"
SET
  "contentStatus" = 'draft',
  "contentSchemaVersion" = NULL,
  "indexingStatus" = 'noindex',
  "publishedAt" = NULL
WHERE "contentStatus" NOT IN ('template', 'draft', 'published');

ALTER TABLE "route_pages"
  ADD CONSTRAINT "route_pages_content_status_check"
    CHECK ("contentStatus" IN ('template', 'draft', 'published')),
  ADD CONSTRAINT "route_pages_indexing_status_check"
    CHECK ("indexingStatus" IN ('noindex', 'index')),
  ADD CONSTRAINT "route_pages_published_contract_check"
    CHECK (
      "contentStatus" <> 'published'
      OR (
        "contentSchemaVersion" = 1
        AND "template" = 'article'
        AND "publishedAt" IS NOT NULL
      )
    );

CREATE INDEX "route_pages_contentStatus_indexingStatus_idx"
  ON "route_pages"("contentStatus", "indexingStatus");
