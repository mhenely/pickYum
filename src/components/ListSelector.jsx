import { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  allLists,
  DEFAULT_LIST_CHIP_COLOR,
} from '../utils/favoriteLists';

// Multi-select dropdown for picking WHICH lists drive the surrounding
// favorites surface. The closed button summarizes the current
// selection ("Date Night", "Date Night + 2", "All lists", "No lists");
// the open menu shows a checkbox per list plus two quick actions:
// "Select all" and "Default only". Users can pick any subset; the
// caller renders the UNION of every selected list's entries.
//
// Used in:
//   - Search page "Your Lists" section header
//   - Compare page favorites sidebar header
//   - Choose page favorites strip header
//
// Independent selection across pages — Compare can be showing
// "Date Night" while Search shows "Date Night + Tokyo 2026."
// Persistence is the caller's job (readActiveListIds /
// writeActiveListIds in utils/favoriteLists).
//
// Props:
//   value         — number[] of currently-selected list ids. An
//                   empty array is a valid state (renders "No lists
//                   selected" and surfaces an empty list).
//   onChange      — (nextIds: number[]) => void; called whenever the
//                   user toggles a checkbox or hits a quick action.
//                   The caller is expected to persist + re-render.
//   defaultId     — the default list's id, used by the "Default
//                   only" quick action. Optional; the button is
//                   hidden when there's no default.
//   align         — 'left' | 'right'. Anchors the dropdown menu.
//                   Default 'left'.
export default function ListSelector({ value, onChange, defaultId, align = 'left' }) {
  const lists = useSelector(allLists);

  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectedSet = useMemo(() => new Set(value ?? []), [value]);
  const allIds = useMemo(() => lists.map((l) => l.id), [lists]);
  const allSelected = lists.length > 0 && lists.every((l) => selectedSet.has(l.id));
  const noneSelected = !value || value.length === 0;

  // Summary label for the closed button.
  //   0 lists checked → "No lists"
  //   1 list checked  → "<list name>"
  //   all checked     → "All lists"
  //   else            → "<first list name> + N more"
  // Total entry count is summed across the selected lists so the
  // user sees an aggregate alongside the label.
  const summary = useMemo(() => {
    if (lists.length === 0) return { label: 'No lists', count: null };
    if (noneSelected)        return { label: 'No lists selected', count: 0 };
    if (allSelected)         return { label: 'All lists', count: sumEntries(lists) };
    const picked = lists.filter((l) => selectedSet.has(l.id));
    const total  = sumEntries(picked);
    if (picked.length === 1) return { label: picked[0].name, count: total };
    return { label: `${picked[0].name} + ${picked.length - 1}`, count: total };
  }, [lists, selectedSet, allSelected, noneSelected]);

  // Color swatch on the closed button: the single selected list's
  // color when exactly one is picked, otherwise the neutral chip
  // color (the swatch is mostly a visual anchor — the count below
  // is the more useful info when many lists are picked).
  const swatchColor = useMemo(() => {
    if (lists.length === 0 || noneSelected || allSelected) return DEFAULT_LIST_CHIP_COLOR;
    const picked = lists.filter((l) => selectedSet.has(l.id));
    if (picked.length === 1) return picked[0].color ?? DEFAULT_LIST_CHIP_COLOR;
    return DEFAULT_LIST_CHIP_COLOR;
  }, [lists, selectedSet, allSelected, noneSelected]);

  function toggleListId(id) {
    if (selectedSet.has(id)) onChange?.((value ?? []).filter((x) => x !== id));
    else                     onChange?.([...(value ?? []), id]);
  }

  function selectAll()    { onChange?.(allIds); }
  function selectDefault() {
    if (defaultId != null) onChange?.([defaultId]);
  }

  const menuAlignCls = align === 'right' ? 'right-0' : 'left-0';

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-300 rounded-md text-sm hover:border-gray-400 focus:outline-none focus:border-orange-500"
      >
        <span
          aria-hidden
          className="w-3 h-3 rounded-full shrink-0 border border-gray-300"
          style={{ background: swatchColor }}
        />
        <span className="font-medium truncate max-w-[10rem]">{summary.label}</span>
        {summary.count != null && (
          <span className="text-xs text-gray-500">({summary.count})</span>
        )}
        <span aria-hidden className="text-gray-400 text-xs">▾</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Pick which lists to show"
          className={`absolute ${menuAlignCls} top-full mt-1 z-50 w-60 max-h-80 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg py-1`}
        >
          {/* Quick actions — pinned at the top so they don't scroll
              out of reach when a user has many lists. "Select all"
              is the multi-list "show everything" shortcut; "Default
              only" mirrors the original single-select behavior. */}
          <div className="flex items-center gap-1 px-2 pb-1 border-b border-gray-100 mb-1">
            <button
              type="button"
              onClick={selectAll}
              disabled={allSelected || lists.length === 0}
              className="text-xs px-2 py-1 rounded text-orange-600 hover:bg-orange-50 disabled:text-gray-400 disabled:hover:bg-transparent disabled:cursor-not-allowed"
            >
              Select all
            </button>
            {defaultId != null && (
              <button
                type="button"
                onClick={selectDefault}
                disabled={value?.length === 1 && value[0] === defaultId}
                className="text-xs px-2 py-1 rounded text-gray-600 hover:bg-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              >
                Default only
              </button>
            )}
          </div>
          {lists.length === 0 && (
            <div className="px-3 py-1.5 text-sm text-gray-500 italic">No lists yet</div>
          )}
          {lists.map((list) => {
            const checked = selectedSet.has(list.id);
            return (
              <label
                key={list.id}
                className={`flex items-center gap-2 px-3 py-1.5 hover:bg-gray-100 text-sm cursor-pointer ${
                  checked ? 'bg-orange-50' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleListId(list.id)}
                  className="rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                />
                <span
                  aria-hidden
                  className="w-3 h-3 rounded-full shrink-0 border border-gray-300"
                  style={{ background: list.color ?? DEFAULT_LIST_CHIP_COLOR }}
                />
                <span className="flex-1 truncate">
                  {list.name}
                  {list.isDefault && (
                    <span className="ml-1 text-[10px] uppercase tracking-wider text-gray-400">default</span>
                  )}
                </span>
                <span className="text-xs text-gray-500">{list.entries.length}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Sum of entry counts across an array of lists. Pulled out so the
// summary memo stays readable.
function sumEntries(lists) {
  let total = 0;
  for (const l of lists) total += l.entries?.length ?? 0;
  return total;
}
