-- Legacy analytics writers historically relied on the column default, so
-- events emitted by fixture or internal users were stored as customer data.
-- Preserve explicit non-customer classifications and repair only defaulted
-- rows whose owning user now has authoritative provenance.
UPDATE "analytics_events" AS events
SET "dataClass" = users."dataClass"
FROM "users" AS users
WHERE events."userId" = users.id
  AND events."dataClass" = 'customer'
  AND users."dataClass" <> 'customer';
