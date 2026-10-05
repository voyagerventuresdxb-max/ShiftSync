-- Pin-only floor sections (2026-09-29).
--
-- A section is now a named pin at a point on the floor plan, not a drawn
-- polygon. pin_x / pin_y are fractions (0-1) of the plan's width/height —
-- the same fractional space the polygon points already used.
--
-- Backfill: every existing section gets the vertex average of its polygon,
-- which is exactly where SectionOverlay rendered the pin until now, so no pin
-- moves on screen. Sections with an empty/invalid polygon (no average to
-- take) land at the plan's centre (0.5, 0.5) and are reported below, for a
-- manager to drag into place.
--
-- `polygon` is kept (deprecated, defaulted to []) so this can be reverted;
-- dropping it is a separate, later cleanup.

ALTER TABLE "floor_sections"
  ADD COLUMN "pin_x" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN "pin_y" DOUBLE PRECISION NOT NULL DEFAULT 0.5;

ALTER TABLE "floor_sections" ALTER COLUMN "polygon" SET DEFAULT '[]';

UPDATE "floor_sections" AS s
SET "pin_x" = c.x, "pin_y" = c.y
FROM (
  SELECT fs."id", avg((p->>'x')::double precision) AS x, avg((p->>'y')::double precision) AS y
  FROM "floor_sections" fs
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(fs."polygon"::jsonb) = 'array' THEN fs."polygon"::jsonb ELSE '[]'::jsonb END
  ) AS p
  WHERE jsonb_typeof(p->'x') = 'number' AND jsonb_typeof(p->'y') = 'number'
  GROUP BY fs."id"
) AS c
WHERE s."id" = c."id";

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT fs."id", fs."label", fs."location_id"
    FROM "floor_sections" fs
    WHERE jsonb_typeof(fs."polygon"::jsonb) <> 'array'
       OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(fs."polygon"::jsonb) p
         WHERE jsonb_typeof(p->'x') = 'number' AND jsonb_typeof(p->'y') = 'number'
       )
  LOOP
    RAISE NOTICE 'floor_section_pin backfill: section % ("%", location %) has no polygon points — pin placed at plan centre (0.5, 0.5)', r."id", r."label", r."location_id";
  END LOOP;
END $$;
