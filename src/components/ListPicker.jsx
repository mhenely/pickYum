import { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { api } from '../lib/api';
import {
  allLists,
  listsContaining,
  DEFAULT_LIST_CHIP_COLOR,
  MAX_LIST_NAME_LEN,
} from '../utils/favoriteLists';
import {
  addEntryToList,
  removeEntryFromList,
  upsertFavoriteList,
} from '../redux/slices/userInfoSlice';

// Multi-select popover for the heart-icon kebab. Shows every list the
// user owns with a pre-checked indicator for the lists this restaurant
// is already in. Clicking a row immediately toggles membership server-
// side AND mirrors into Redux — same pattern as the favorites heart.
//
// Inline "Create new list" surface at the bottom: a small text input
// (no color picker — keeps the kebab compact). New lists default to a
// neutral chip color; users can change color from List Management
// later. This is per the design doc's "inline create option = yes."
//
// Props:
//   restaurantId   — required, the row this picker is operating on
//   onClose        — fired when the user clicks outside, presses Esc,
//                    or clicks the close button. Caller controls the
//                    anchor / placement.
//   onOpenManage   — optional; when present, the "Manage lists…"
//                    footer button is shown and clicking it calls
//                    this instead of opening anything locally. The
//                    parent should close us AND open its own
//                    management modal — that way the modal survives
//                    our outside-click dismissal logic (a click on
//                    the modal's portaled overlay would otherwise
//                    count as "outside" us and unmount us mid-edit).
//   anchorRef      — optional ref to the element that opened this
//                    picker (the kebab button). Clicks on the
//                    anchor are NOT treated as outside-clicks, so
//                    clicking the kebab again can close the picker
//                    cleanly without our mousedown handler firing
//                    first and creating a close→reopen flicker.
//
// Positioning is the caller's responsibility — wrap us in an
// absolutely-positioned div anchored to the kebab button.
export default function ListPicker({ restaurantId, onClose, onOpenManage, anchorRef }) {
  const dispatch = useDispatch();
  const lists      = useSelector(allLists);
  const membership = useSelector((s) => listsContaining(s, restaurantId));

  const [creating,  setCreating]  = useState(false);
  const [newName,   setNewName]   = useState('');
  // Tracks one list id at a time to surface a per-row pending
  // indicator (the checkbox dims briefly). Not a full Set because the
  // kebab is rarely click-spammed; the row-level optimism is enough.
  const [pendingId, setPendingId] = useState(null);
  const [error,     setError]     = useState(null);

  const containerRef = useRef(null);

  // Close on outside-click + Escape. Same pattern as the existing
  // OnboardingModal / ChosenCelebration — caller owns the open state,
  // we just emit `onClose` requests.
  useEffect(() => {
    function onDocClick(e) {
      const inPicker = containerRef.current?.contains(e.target);
      const onAnchor = anchorRef?.current?.contains(e.target);
      if (!inPicker && !onAnchor) onClose?.();
    }
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, anchorRef]);

  async function handleToggle(list) {
    if (pendingId === list.id) return;
    setError(null);
    setPendingId(list.id);
    const numericId = Number(restaurantId);
    try {
      if (membership[list.id]) {
        await api.users.removeFavoriteListEntry(list.id, numericId);
        dispatch(removeEntryFromList({ listId: list.id, restaurantId: numericId }));
      } else {
        const { entry } = await api.users.addFavoriteListEntry(list.id, { restaurantId: numericId });
        dispatch(addEntryToList({ listId: list.id, entry }));
      }
    } catch (err) {
      setError(err?.message ?? 'Update failed');
    } finally {
      setPendingId(null);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_LIST_NAME_LEN) {
      setError(`Name must be ${MAX_LIST_NAME_LEN} characters or fewer`);
      return;
    }
    setError(null);
    setPendingId('create');
    try {
      const { list } = await api.users.createFavoriteList({ name: trimmed });
      dispatch(upsertFavoriteList(list));
      // Auto-add the current restaurant to the new list — the user
      // opened the picker on a card; "create new list" almost always
      // means "create AND add this restaurant to it."
      const numericId = Number(restaurantId);
      const { entry } = await api.users.addFavoriteListEntry(list.id, { restaurantId: numericId });
      dispatch(addEntryToList({ listId: list.id, entry }));
      setNewName('');
      setCreating(false);
    } catch (err) {
      setError(err?.message ?? 'Could not create list');
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Pick lists for this restaurant"
      className="w-56 bg-white border border-gray-200 rounded-lg shadow-lg p-2 text-sm z-50"
    >
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="font-semibold text-gray-700">Add to list</span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-gray-400 hover:text-gray-600 leading-none"
        >
          ✕
        </button>
      </div>

      <ul className="max-h-56 overflow-y-auto py-1">
        {lists.length === 0 && (
          <li className="px-2 py-1 text-gray-500 italic">No lists yet</li>
        )}
        {lists.map((list) => {
          const checked = !!membership[list.id];
          const pending = pendingId === list.id;
          return (
            <li key={list.id}>
              <button
                onClick={() => handleToggle(list)}
                disabled={pending}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-100 text-left ${
                  pending ? 'opacity-60 cursor-progress' : ''
                }`}
              >
                <span
                  aria-hidden
                  className="w-3 h-3 rounded-full shrink-0 border border-gray-300"
                  style={{ background: list.color ?? DEFAULT_LIST_CHIP_COLOR }}
                />
                <span className="flex-1 truncate">{list.name}</span>
                <span
                  aria-hidden
                  className={`inline-flex w-4 h-4 items-center justify-center border rounded ${
                    checked ? 'bg-orange-500 border-orange-500 text-white' : 'border-gray-300'
                  }`}
                >
                  {checked && '✓'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="pt-1 border-t border-gray-100">
        {creating ? (
          <form onSubmit={handleCreate} className="flex gap-1 px-1 py-1">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={MAX_LIST_NAME_LEN}
              placeholder="New list name…"
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:border-orange-500"
            />
            <button
              type="submit"
              disabled={pendingId === 'create' || !newName.trim()}
              className="px-2 py-1 bg-orange-500 text-white rounded text-xs font-semibold disabled:opacity-50"
            >
              Add
            </button>
          </form>
        ) : (
          <>
            <button
              onClick={() => setCreating(true)}
              className="w-full px-2 py-1.5 text-left text-orange-600 hover:bg-orange-50 rounded"
            >
              + New list
            </button>
            {/* Full CRUD entry point — rename / reorder / delete /
                promote-default. Defers actual rendering to the
                parent via `onOpenManage` so the modal's portal
                isn't unmounted when our outside-click handler
                closes us (a click on the modal overlay counts as
                "outside" us). */}
            {onOpenManage && (
              <button
                onClick={onOpenManage}
                className="w-full px-2 py-1.5 text-left text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded"
              >
                Manage lists…
              </button>
            )}
          </>
        )}
      </div>

      {error && (
        <div className="px-2 py-1 text-xs text-red-600">{error}</div>
      )}
    </div>
  );
}
