// Tiny shared skeleton building block — a grey rounded rectangle with a
// subtle pulse animation. Compose multiple of these to mock up a real card
// shape so the page doesn't jump when the data arrives. Tailwind's animate-
// pulse handles the breathing effect; explicit width/height keeps the
// layout stable.
//
// Used by list pages (Trips, Groups) to replace "Loading…" text with a
// pre-shaped placeholder. The width prop accepts any Tailwind width class
// ('w-full', 'w-32', etc.) since callers know their layout best.
export function SkeletonLine({ width = 'w-full', height = 'h-3', className = '' }) {
  return (
    <div className={`${width} ${height} rounded bg-gray-200 animate-pulse ${className}`} />
  );
}

// Card-shaped skeleton mimicking a TripListEntry / GroupListEntry row.
// Three lines (title, subtitle, meta) + a faint right-side block. Sized to
// roughly match the real card so the page doesn't reflow when the actual
// data lands.
export function SkeletonListCard() {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 flex items-start gap-3">
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <SkeletonLine width="w-1/3" height="h-4" />
        <SkeletonLine width="w-1/2" height="h-2.5" />
        <SkeletonLine width="w-2/3" height="h-2.5" />
      </div>
      <div className="w-12 h-8 rounded bg-gray-100 animate-pulse shrink-0" />
    </div>
  );
}

// Convenience wrapper: N skeleton cards in a column with the same spacing
// the real list uses. `count` defaults to 3 — enough to fill the visible
// area on most viewports without scaring people into thinking they have
// loads of pending data.
export function SkeletonList({ count = 3 }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }, (_, i) => <SkeletonListCard key={i} />)}
    </div>
  );
}
