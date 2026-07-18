-- Runtime publication contracts cap paths at 512 characters. Refuse to
-- qualify a legacy publication that the application would immediately reject.
DO $route_page_authority_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM route_pages
    WHERE "contentStatus" = 'published'
      AND (
        char_length(path) > 512
        OR char_length(COALESCE(canonical, '')) > 512
      )
  ) THEN
    RAISE EXCEPTION
      'legacy published RoutePage path or canonical exceeds the 512 character runtime contract';
  END IF;
END;
$route_page_authority_preflight$;
