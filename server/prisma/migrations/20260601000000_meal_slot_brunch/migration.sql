-- Add BRUNCH to the MealSlot enum, positioned between BREAKFAST and LUNCH.
-- Postgres enums are ordered by declaration position; placing BRUNCH after
-- BREAKFAST keeps the calendar sort key (breakfast→brunch→lunch→dinner→snack)
-- consistent with how the frontend renders the day-by-day itinerary.
ALTER TYPE "MealSlot" ADD VALUE 'BRUNCH' BEFORE 'LUNCH';
