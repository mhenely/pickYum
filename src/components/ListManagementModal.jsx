import { useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { api } from '../lib/api';
import {
  allLists,
  LIST_COLOR_PALETTE,
  DEFAULT_LIST_CHIP_COLOR,
  MAX_LIST_NAME_LEN,
  MAX_LIST_DESCRIPTION_LEN,
} from '../utils/favoriteLists';
import {
  removeFavoriteList,
  setFavoriteListsOrder,
  upsertFavoriteList,
} from '../redux/slices/userInfoSlice';

// Full CRUD UI for the user's favorite lists. Surfaced from a "Manage
// lists" button next to ListSelector on the Search page (per the
// design doc — modal-not-page for v1). Renders a vertical stack of
// list rows; each row has color swatch · name · entry count · ↑ / ↓ /
// edit / delete controls. Delete is disabled when the list is
// default (per the server-side guard).
//
// Inline editor: clicking "Edit" opens a small form panel below the
// row with name / description / color picker. Inline "New list"
// button at the top opens the same form for creation.
//
// Props:
//   open    — boolean, whether the dialog is rendered
//   onClose — () => void, fired on Esc / overlay click / close button
export default function ListManagementModal({ open, onClose }) {
  const dispatch = useDispatch();
  const lists = useSelector(allLists);

  // editingId === 'new' → render the create form
  // editingId === <number> → render the edit form for that list
  // editingId === null → no form open
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function clearForm() { setEditingId(null); setError(null); }

  async function handleReorder(idx, direction) {
    const swapWith = idx + direction;
    if (swapWith < 0 || swapWith >= lists.length) return;
    const next = [...lists];
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    const order = next.map((l) => l.id);
    // Optimistic — apply locally first so the row visually moves
    // before the server round-trip completes. On failure we re-fetch
    // /me/all in a follow-up (TODO).
    dispatch(setFavoriteListsOrder(order));
    try {
      await api.users.reorderFavoriteLists(order);
    } catch (err) {
      setError(err?.message ?? 'Reorder failed — refresh to see the canonical order');
    }
  }

  async function handleDelete(list) {
    if (list.isDefault) return;
    if (lists.length <= 1) return;
    // Inline confirm — the modal is already a focused surface; a
    // second dialog would feel heavy. Window.confirm is fine here.
    if (!window.confirm(`Delete "${list.name}"? Restaurants in this list aren't deleted — they just leave this list.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.users.deleteFavoriteList(list.id);
      dispatch(removeFavoriteList(list.id));
    } catch (err) {
      setError(err?.message ?? 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  async function handlePromote(list) {
    if (list.isDefault) return;
    setBusy(true);
    setError(null);
    try {
      const { list: promoted } = await api.users.promoteFavoriteList(list.id);
      dispatch(upsertFavoriteList(promoted));
    } catch (err) {
      setError(err?.message ?? 'Could not promote list');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-md bg-white rounded-xl shadow-xl max-h-[90vh] flex flex-col">
          <div className="flex items-center justify-between px-5 py-3 border-b">
            <DialogTitle className="font-semibold text-lg">Manage favorite lists</DialogTitle>
            <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600">
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {error && (
            <div className="px-5 py-2 bg-red-50 text-sm text-red-700 border-b border-red-100">
              {error}
            </div>
          )}

          <div className="px-5 py-3 border-b">
            {editingId === 'new' ? (
              <ListForm
                onCancel={clearForm}
                onSaved={(list) => {
                  dispatch(upsertFavoriteList(list));
                  clearForm();
                }}
                setError={setError}
              />
            ) : (
              <button
                onClick={() => setEditingId('new')}
                className="w-full px-3 py-2 bg-orange-500 text-white rounded-md font-semibold hover:bg-orange-600"
              >
                + New list
              </button>
            )}
          </div>

          <ul className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
            {lists.length === 0 && (
              <li className="text-gray-500 italic">No lists yet.</li>
            )}
            {lists.map((list, idx) => (
              <li key={list.id} className="border border-gray-200 rounded-lg">
                <div className="flex items-center gap-2 px-3 py-2">
                  <span
                    aria-hidden
                    className="w-3 h-3 rounded-full shrink-0 border border-gray-300"
                    style={{ background: list.color ?? DEFAULT_LIST_CHIP_COLOR }}
                  />
                  <span className="flex-1 truncate">
                    <span className="font-medium">{list.name}</span>
                    {list.isDefault && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-gray-400">default</span>
                    )}
                  </span>
                  <span className="text-xs text-gray-500">{list.entries.length}</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleReorder(idx, -1)}
                      disabled={idx === 0 || busy}
                      aria-label="Move up"
                      className="px-1.5 text-gray-500 hover:text-gray-800 disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => handleReorder(idx, +1)}
                      disabled={idx === lists.length - 1 || busy}
                      aria-label="Move down"
                      className="px-1.5 text-gray-500 hover:text-gray-800 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => setEditingId(list.id)}
                      className="text-xs px-2 py-1 text-orange-600 hover:bg-orange-50 rounded"
                    >
                      Edit
                    </button>
                    {!list.isDefault && (
                      <button
                        onClick={() => handlePromote(list)}
                        disabled={busy}
                        className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-100 rounded"
                      >
                        Make default
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(list)}
                      disabled={list.isDefault || lists.length <= 1 || busy}
                      title={list.isDefault ? 'Promote another list to default first' : 'Delete this list'}
                      className="text-xs px-2 py-1 text-red-600 hover:bg-red-50 rounded disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {editingId === list.id && (
                  <div className="border-t border-gray-100 px-3 py-2 bg-gray-50">
                    <ListForm
                      list={list}
                      onCancel={clearForm}
                      onSaved={(updated) => {
                        dispatch(upsertFavoriteList(updated));
                        clearForm();
                      }}
                      setError={setError}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

// Inline create / edit form. Shared between the "New list" button at
// the top of the modal and the per-row Edit panel. When `list` is
// passed in, we're editing; otherwise we're creating.
function ListForm({ list, onCancel, onSaved, setError }) {
  const isEdit = !!list;
  const [name,        setName]        = useState(list?.name ?? '');
  const [description, setDescription] = useState(list?.description ?? '');
  const [color,       setColor]       = useState(list?.color ?? null);
  const [submitting,  setSubmitting]  = useState(false);

  const nameValid = useMemo(() => name.trim().length > 0 && name.length <= MAX_LIST_NAME_LEN, [name]);

  async function submit(e) {
    e.preventDefault();
    if (!nameValid) return;
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() ? description : null,
        color,
      };
      const { list: saved } = isEdit
        ? await api.users.updateFavoriteList(list.id, body)
        : await api.users.createFavoriteList(body);
      onSaved(saved);
    } catch (err) {
      setError(err?.message ?? (isEdit ? 'Could not save list' : 'Could not create list'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div>
        <label className="block text-xs font-semibold text-gray-600 mb-1">Name</label>
        <input
          autoFocus={!isEdit}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={MAX_LIST_NAME_LEN}
          placeholder="e.g. Date Night, Tokyo 2026"
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:border-orange-500"
          required
        />
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-600 mb-1">Description (optional)</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={MAX_LIST_DESCRIPTION_LEN}
          placeholder="What's this list for?"
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:border-orange-500"
        />
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-600 mb-1">Color</label>
        <div className="flex flex-wrap gap-1">
          {/* Neutral / no-color swatch (renders the default chip color) */}
          <ColorSwatch
            displayColor={DEFAULT_LIST_CHIP_COLOR}
            selected={color === null}
            onClick={() => setColor(null)}
            label="Default color"
          />
          {LIST_COLOR_PALETTE.map((c) => (
            <ColorSwatch
              key={c}
              displayColor={c}
              selected={color === c}
              onClick={() => setColor(c)}
              label={c}
            />
          ))}
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={!nameValid || submitting}
          className="px-3 py-1.5 bg-orange-500 text-white rounded text-sm font-semibold disabled:opacity-50"
        >
          {isEdit ? 'Save' : 'Create'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// `displayColor` is the visual swatch fill; selected/onClick/label
// drive the ring + interaction. The raw color value (used to
// communicate the user's choice) is encoded into the caller's
// onClick closure, not passed through here.
function ColorSwatch({ displayColor, selected, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
      className={`w-7 h-7 rounded-full border-2 ${
        selected ? 'border-gray-900 scale-110' : 'border-gray-300 hover:border-gray-500'
      } transition-transform`}
      style={{ background: displayColor }}
    />
  );
}
