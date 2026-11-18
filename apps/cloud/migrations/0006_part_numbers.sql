-- Give existing parts the part number in their file name: the first number of exactly seven digits
-- ("2600076_24_5_260626.stl" → 2600076). Parts that already have one keep it. New parts get theirs
-- when they're first recorded (partNumberFromName in @fleet/shared).
WITH RECURSIVE pos(id, name, i) AS (
  SELECT id, name, 1 FROM parts WHERE part_number IS NULL AND length(name) >= 7
  UNION ALL
  SELECT id, name, i + 1 FROM pos WHERE i + 7 <= length(name)
),
found(id, part_number) AS (
  SELECT id, substr(name, min(i), 7) FROM pos
  WHERE substr(name, i, 7) GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
    AND (i = 1 OR substr(name, i - 1, 1) NOT GLOB '[0-9]')
    AND substr(name, i + 7, 1) NOT GLOB '[0-9]'
  GROUP BY id
)
UPDATE parts SET part_number = (SELECT part_number FROM found WHERE found.id = parts.id)
WHERE part_number IS NULL AND id IN (SELECT id FROM found);
