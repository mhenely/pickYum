import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';
import { toggleAcceptedExcludeFromInsights } from '../redux/slices/userInfoSlice';

// Per-row kebab for HistoryPage. Currently exposes a single action:
// toggle the InsightsPage opt-out flag for this restaurant's accepted
// entries. Kept separate from <HeartWithKebab> because that component
// is shared across Compare / Choose / Search / History surfaces and is
// scoped to list-management concerns; insights opt-out is HistoryPage-
// only and shouldn't bleed into the list-picker metaphor.
//
// Behavior:
//   - "Exclude from insights" / "Include in insights" toggles the flag
//     on EVERY accepted row for this restaurant. The semantic answer to
//     "should this place count?" is per-restaurant, not per-visit — a
//     user who excludes a NYC trip pick excludes all their trip-week
//     visits to the same place. (Per-visit toggling, if ever requested,
//     would surface inside the detail modal's reviews list.)
//   - Hidden entirely when the user has no accepted rows for the
//     restaurant — the toggle has nothing to operate on.
//   - Renders a faint badge next to the kebab when at least one of the
//     restaurant's accepted rows is excluded, so the off-the-record
//     state is visible without opening the menu.
//
// Same fixed-portal positioning trick as <HeartWithKebab>: HistoryPage
// rows are inside scrollable grids, so a normal absolute popover would
// clip at the container edge. Measuring viewport coords + tracking
// scroll/resize keeps the popover glued to the button.
export default function HistoryRowKebab({ restaurantId, size = 'md' }) {
  const dispatch = useDispatch();

  // Pull all accepted rows for this restaurant. We expose ONE toggle
  // that flips all of them together; the kebab's label reflects the
  // dominant state (any excluded → "Include all", none excluded →
  // "Exclude from insights").
  const acceptedRows = useSelector((s) => {
    const list = s.userInfo?.users?.[0]?.accepted ?? [];
    const rid = String(restaurantId);
    return list.filter((a) => String(a.restaurantId) === rid);
  });

  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const [pos, setPos] = useState(null);

  useEffect(() => {
    if (!open) { setPos(null); return undefined; }
    const measure = () => {
      const btn = btnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    };
    measure();
    // Capture phase catches nested overflow containers (sidebars), not
    // just the window. Mirrors <HeartWithKebab>.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  // Outside-click dismissal. Click on the kebab itself doesn't count
  // (the handler toggles already), so we filter it out by ref.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (btnRef.current && btnRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (acceptedRows.length === 0) return null;

  // "Any excluded" rather than "all excluded": if a user has 3 visits to
  // a place and one is excluded, the dominant action is "include all"
  // (re-enable insights for this place); flipping that to exclude
  // explicitly requires another click. Keeps the toggle predictable.
  const anyExcluded = acceptedRows.some((a) => a.excludeFromInsights);

  // We can only PATCH rows that have a server id. Optimistic-but-not-yet-
  // reconciled entries (rare; only happens between POST /me/accepted and
  // its response) get skipped. Once reconciled by listener middleware
  // they become flippable.
  const targets = acceptedRows.filter((a) => a.id != null);
  const canToggle = targets.length > 0;

  function handleToggle(e) {
    e.stopPropagation();
    setOpen(false);
    const next = !anyExcluded;
    for (const row of targets) {
      // Only fire a network call for rows whose state would actually
      // change — saves N PATCH roundtrips when most rows are already
      // in the target state.
      if (row.excludeFromInsights !== next) {
        dispatch(toggleAcceptedExcludeFromInsights({
          acceptedId: row.id,
          excludeFromInsights: next,
        }));
      }
    }
  }

  const kebabCls = size === 'sm' ? 'text-xs px-1' : 'text-sm px-1';
  const badgeCls = size === 'sm' ? 'text-[9px]' : 'text-[10px]';

  return (
    <div className="relative inline-flex items-center gap-0.5 shrink-0">
      {anyExcluded && (
        <span
          className={`${badgeCls} font-medium text-gray-400 italic`}
          title="Excluded from insights — won't count in your taste profile"
        >
          off-record
        </span>
      )}
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-label="History row actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${kebabCls} leading-none text-gray-400 hover:text-gray-700`}
      >
        ⋮
      </button>
      {open && pos && createPortal(
        <div
          role="menu"
          className="fixed z-[60] min-w-[220px] bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm"
          style={{ top: pos.top, right: pos.right }}
          // Stop propagation so clicks inside the menu don't bubble
          // up to the card's onCardClick (which would open the detail
          // modal).
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleToggle}
            disabled={!canToggle}
            className="w-full text-left px-3 py-2 hover:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
          >
            {anyExcluded ? 'Include in insights' : 'Exclude from insights'}
          </button>
          <div className="px-3 pb-2 pt-1 text-[11px] text-gray-400 leading-tight">
            {anyExcluded
              ? 'This place will count again in your taste profile.'
              : 'Keep this in your history but don’t let it shape your taste profile.'}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
