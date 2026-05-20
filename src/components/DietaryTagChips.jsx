// Compact inline chip strip for a user's dietary tags. Used on group +
// trip member rows so planners can scan dietary restrictions at a glance
// without opening each member's profile.
//
// Caps the visible count at `maxVisible` (default 4); overflow collapses
// to "+N more" so a member with 8 allergies doesn't wrap the row.
export default function DietaryTagChips({ tags, maxVisible = 4 }) {
  if (!tags || tags.length === 0) return null;
  const visible = tags.slice(0, maxVisible);
  const overflow = tags.length - visible.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {visible.map((t) => (
        <span
          key={t}
          className="rounded-full bg-emerald-50 border border-emerald-100 text-emerald-700 text-[10px] px-1.5 py-0.5"
        >
          {t}
        </span>
      ))}
      {overflow > 0 && (
        <span className="text-[10px] text-gray-400">+{overflow} more</span>
      )}
    </span>
  );
}
