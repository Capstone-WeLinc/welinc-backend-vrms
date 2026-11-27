-- Spec 0030, AC-4: each issue category's optional fix time, in hours of shop work.
ALTER TABLE "issue_categories" ADD COLUMN "fix_hours" DECIMAL(5,2);

-- The seven starting categories come from the baseline migration. Typical shop hours for a light
-- and medium truck shop, set by name_key and only where nothing is set yet, so an Admin's own
-- values survive a rerun.
UPDATE "issue_categories" AS c
SET "fix_hours" = v.hours
FROM (VALUES
  ('brakes', 6.00),
  ('engine', 48.00),
  ('electrical', 8.00),
  ('suspension', 12.00),
  ('cooling', 8.00),
  ('transmission', 24.00),
  ('general', 4.00)
) AS v(name_key, hours)
WHERE c."name_key" = v.name_key AND c."fix_hours" IS NULL;
