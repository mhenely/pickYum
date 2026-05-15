import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';
import { isInAnyList } from '../utils/favoriteLists';
import { updateUserFavorites } from '../redux/slices/userInfoSlice';
import ListPicker from './ListPicker';
import ListManagementModal from './ListManagementModal';

// Drop-in heart-icon replacement that adds a multi-list kebab next
// to the heart for users with more than one list. Encapsulates the
// "heart icon NEVER changes meaning regardless of list count"
// invariant — heart always toggles default-list membership, kebab
// (when present) opens the multi-list picker.
//
// Implementation notes:
//   - The heart dispatches `updateUserFavorites` (the existing legacy
//     action). The slice reducer mirrors the toggle into the default
//     list's entries; the listener middleware persists the change to
//     the new /favorite-lists endpoint server-side. This keeps every
//     existing heart call site working without rewrite.
//   - The kebab opens <ListPicker>, which mutates non-default lists
//     directly via the favorite-list-entries API.
//   - Guests fall back to the legacy users[0].favorites array via the
//     same reducer + listener (the listener early-returns on guest).
//
// Props:
//   restaurantId   — numeric id; passing a string `local-...` ID is a
//                    guest path which we still render (heart toggles
//                    the local array), but the kebab is hidden because
//                    guests don't have multi-list state.
//   size           — 'sm' | 'md' (default 'md'). Matches RestaurantCard
//                    size knob.
//   onPickerOpen   — optional, fired with `restaurantId` when the kebab
//                    opens the multi-list picker. Sidebars that filter
//                    visible cards by active-list membership use this
//                    to "pin" the in-progress card so unchecking its
//                    last list doesn't immediately yank the card out
//                    of view mid-edit. See the sidebar callers'
//                    `stickyId` state.
//   onPickerClose  — optional, fired with `restaurantId` when the
//                    picker dismisses (outside-click, Esc, X button,
//                    or transition to the management modal).
export default function HeartWithKebab({
  restaurantId,
  size = 'md',
  onPickerOpen,
  onPickerClose,
}) {
  const dispatch = useDispatch();
  const isAuthed   = useSelector((s) => s.auth?.status === 'authenticated');
  // Fill state tracks membership in ANY list, not just the default —
  // a card the user has put in "Date Night" reads as "favorited" the
  // same way one in "My Favorites" does. The click handler below
  // still targets the default list specifically (the documented
  // invariant), but the visual indicator answers the broader
  // question "have I favorited this anywhere?". Power users with
  // multi-list state stay aware of their bookmarks regardless of
  // which list a row landed in.
  const favorited  = useSelector((s) => isInAnyList(s, restaurantId));
  const listCount  = useSelector((s) => s.userInfo?.favoriteLists?.order?.length ?? 0);
  const guestFavs  = useSelector((s) => s.userInfo?.users?.[0]?.favorites ?? []);
  // Guest fallback — without any lists, the legacy favorites array
  // is the source of truth. Used pre-hydrate too so the heart stays
  // responsive before /me/all completes.
  const guestFavorited = guestFavs.some((id) => String(id) === String(restaurantId));
  const isFavorited = isAuthed && listCount > 0 ? favorited : guestFavorited;

  const [pickerOpen, setPickerOpen] = useState(false);
  // Management modal opens when the user clicks "Manage lists…" inside
  // the picker. Rendered HERE (not inside ListPicker) so the picker
  // can dismiss itself without unmounting the modal — the modal's
  // Headless-UI Dialog portals to body, so a click on its overlay
  // counts as "outside" the picker and would otherwise close both.
  const [manageOpen, setManageOpen] = useState(false);

  // The picker has to portal to <body>: cards live inside
  // overflow-y-auto containers (Compare/Choose sidebars, detail
  // modal, etc.) that would clip an absolutely-positioned popover
  // at the scroll boundary. To position the portaled popover we
  // measure the kebab button's viewport rect once we know it's
  // open, then re-measure on scroll/resize so the popover tracks
  // the button if the page moves underneath us.
  const kebabRef = useRef(null);
  const [pickerPos, setPickerPos] = useState(null);

  useEffect(() => {
    if (!pickerOpen) { setPickerPos(null); return undefined; }
    const measure = () => {
      const btn = kebabRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setPickerPos({
        // Anchor the popover's TOP just below the kebab and align
        // its RIGHT edge with the kebab's right edge — same visual
        // result the old `absolute top-full right-0 mt-1` had.
        top:   r.bottom + 4,
        right: window.innerWidth - r.right,
      });
    };
    measure();
    // Track scroll/resize so the popover stays glued to the button
    // if the user scrolls a sidebar or the page while the popover
    // is open. `true` for the scroll listener so we catch nested
    // overflow containers, not just window scroll.
    window.addEventListener('scroll',  measure, true);
    window.addEventListener('resize',  measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [pickerOpen]);

  const heartCls = size === 'sm' ? 'text-base' : 'text-xl';
  const kebabCls = size === 'sm' ? 'text-xs px-1' : 'text-sm px-1';

  function handleHeart(e) {
    e.stopPropagation();
    // Dispatch the legacy action. Reducer mirrors into the default
    // list; the listener middleware persists. No await — feels
    // instant; failures are surfaced through the listener's console.
    dispatch(updateUserFavorites({ restaurantId }));
  }

  function handleKebab(e) {
    e.stopPropagation();
    setPickerOpen((open) => {
      const next = !open;
      if (next) onPickerOpen?.(restaurantId);
      else      onPickerClose?.(restaurantId);
      return next;
    });
  }

  // Wrap setPickerOpen(false) so every close path (X button,
  // outside-click, Esc, "Manage lists…" transition) notifies the
  // parent. Without this the sidebar's sticky pin would leak.
  const closePicker = () => {
    setPickerOpen(false);
    onPickerClose?.(restaurantId);
  };

  // Kebab is visible to any authenticated user, even when they only
  // have the default list. We initially gated this on listCount > 1
  // (the design-doc "no UI noise for single-list users" stance) but
  // that hides the discoverability of multi-list entirely: a user
  // with one list has no way to find the multi-list controls from
  // any card, so they never create a second list, so the kebab stays
  // hidden forever. Showing it always means single-list users see
  // the picker, which always offers "+ New list" — the natural
  // entry point to organizing favorites into multiple lists.
  const showKebab = isAuthed && listCount >= 1;

  return (
    <div className="relative inline-flex items-center gap-0.5 shrink-0">
      <button
        onClick={handleHeart}
        aria-label={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
        aria-pressed={isFavorited}
        className={`${heartCls} leading-none ${
          isFavorited ? 'text-red-500' : 'text-gray-300 hover:text-red-300'
        }`}
      >
        &#9829;
      </button>
      {showKebab && (
        <button
          ref={kebabRef}
          onClick={handleKebab}
          aria-label="Choose lists"
          aria-haspopup="menu"
          aria-expanded={pickerOpen}
          className={`${kebabCls} leading-none text-gray-400 hover:text-gray-700`}
        >
          ⋮
        </button>
      )}
      {pickerOpen && pickerPos && createPortal(
        // Fixed-position wrapper anchored to viewport coords we
        // computed from the kebab. z-50 keeps the popover above
        // every modal-less surface; modals (Headless-UI Dialog) use
        // their own z-stack starting from z-50 too, so the picker
        // explicitly mounts above the management modal when both
        // are open momentarily during the "open Manage" transition.
        <div
          className="fixed z-[60]"
          style={{ top: pickerPos.top, right: pickerPos.right }}
        >
          <ListPicker
            restaurantId={restaurantId}
            anchorRef={kebabRef}
            onClose={closePicker}
            onOpenManage={() => { closePicker(); setManageOpen(true); }}
          />
        </div>,
        document.body,
      )}
      <ListManagementModal open={manageOpen} onClose={() => setManageOpen(false)} />
    </div>
  );
}
