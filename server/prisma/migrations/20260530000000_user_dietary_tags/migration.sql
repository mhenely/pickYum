-- Per-user dietary tags surfaced on group and trip member sections so
-- the host (and other members) can avoid suggesting incompatible meals
-- without asking each member individually. Free-form text array — we
-- recommend a known set in the UI ("vegetarian", "vegan", "gluten-free",
-- "halal", "kosher", "dairy-free", "nut-allergy", "shellfish-allergy")
-- but the column stays open so users can add region- or condition-
-- specific tags ("pescatarian", "low-fodmap", etc.).
--
-- Default empty array (Postgres text[]) so existing rows are equivalent
-- to "no tags." Length validation lives in the route handler — the schema
-- itself only enforces type.
ALTER TABLE "users"
  ADD COLUMN "dietary_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
