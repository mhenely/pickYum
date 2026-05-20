// Host-only voting method picker. Locked once event status leaves OPEN — the
// server enforces this too. For non-hosts (or non-OPEN events) we display a
// read-only badge so everyone knows what kind of vote they're walking into.
//
// Uses an optimistic-with-request-id pattern so rapid back-and-forth
// toggling feels instant without committing stale responses to UI state.

import { useState, useEffect, useRef } from 'react';
import { groupsApi } from '../../lib/groupsApi';

export default function VoteMethodPicker({ groupId, event, isHost, onUpdated }) {
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  // Optimistic value: what the UI should show right NOW, regardless of
  // whether the network has caught up. Cleared once the prop comes back
  // matching it (parent refetched + state propagated), or reverted on
  // error. null means "no override, trust the prop".
  const [optimistic, setOptimistic] = useState(null);
  // Bumped on every click so racing responses from rapid back-and-forth
  // toggling only commit the LAST one. Without this, clicking SIMPLE →
  // RANKED → SIMPLE quickly could see the RANKED response land after the
  // second SIMPLE response and stick.
  const reqIdRef = useRef(0);

  const propValue   = event.voteMethod ?? 'SIMPLE';
  const displayValue = optimistic ?? propValue;

  // Clear optimistic once the parent's data flows back in matching it —
  // and also handle the "user is editing, server is lagging behind"
  // boundary: we DON'T clear if the prop still disagrees, because that
  // would snap the UI back to the stale value mid-flight.
  useEffect(() => {
    if (optimistic != null && propValue === optimistic) setOptimistic(null);
  }, [propValue, optimistic]);

  const handleChange = async (next) => {
    if (next === displayValue) return;
    setOptimistic(next);
    setError('');
    setSaving(true);
    const myReqId = ++reqIdRef.current;
    try {
      await groupsApi.setVoteMethod(groupId, event.id, next);
      // Pass the new method through so the parent applies it locally
      // instead of refetching the whole group.
      if (reqIdRef.current === myReqId) onUpdated(next);
    } catch (err) {
      // Only the latest click owns the error/revert. Older racing
      // requests that fail should be ignored — the user already moved on.
      if (reqIdRef.current === myReqId) {
        setError(err.message);
        setOptimistic(null);
      }
    } finally {
      if (reqIdRef.current === myReqId) setSaving(false);
    }
  };

  const label  = displayValue === 'RANKED' ? 'Ranked-choice' : 'Simple Majority';
  const isOpen = event.status === 'OPEN';

  // Don't bother rendering for non-hosts on locked events — the badge appears
  // inline in the event header instead. We DO render for non-hosts on OPEN
  // events so they can see the host's choice ahead of time.
  if (!isHost && !isOpen) return null;

  return (
    // w-full forces the picker to fill its column even if an ancestor
    // ever accidentally becomes content-sized — defensive against
    // future layout drift. Without this, the description text's length
    // (RANKED is ~155 chars, SIMPLE ~66) could drive the box width.
    <div className="w-full rounded-xl border border-gray-200 bg-white p-4">
      <h4 className="text-sm font-semibold text-gray-700 mb-1">Voting method</h4>
      {/* Both descriptions live in the same grid cell (col-start-1,
          row-start-1). Only the active one is opaque; the other stays
          in the layout via opacity-0 so the cell always reserves the
          height/width of the LONGER copy. Toggling becomes a pure
          opacity flip — zero reflow, identical box size regardless of
          which method is selected. */}
      <div className="grid grid-cols-1 mb-3 text-xs text-gray-500 leading-snug">
        <p
          className={`col-start-1 row-start-1 transition-opacity ${
            displayValue === 'RANKED' ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          aria-hidden={displayValue !== 'RANKED'}
        >
          Each voter ranks every restaurant by preference. Lowest first-place vote is eliminated each round until one has a majority.
        </p>
        <p
          className={`col-start-1 row-start-1 transition-opacity ${
            displayValue === 'SIMPLE' ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          aria-hidden={displayValue !== 'SIMPLE'}
        >
          Each voter approves any number of restaurants. Highest total wins.
        </p>
      </div>
      {isHost && isOpen ? (
        <>
          {/* grid-cols-2 forces both buttons to identical width so the
              active highlight never jumps between two different widths
              when toggling. The old `flex` row sized each button to its
              own label, which made "Simple Majority" wider than
              "Ranked-choice" and produced the visible width shift. */}
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: 'SIMPLE', label: 'Simple Majority' },
              { value: 'RANKED', label: 'Ranked-choice' },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleChange(opt.value)}
                // Deliberately NOT disabled while saving — rapid
                // back-and-forth toggling should feel instant. The
                // request-id ref above guarantees only the latest
                // response commits, so race conditions are safe.
                className={[
                  'rounded-lg px-3 py-1.5 text-xs font-semibold border transition-colors',
                  displayValue === opt.value
                    ? 'bg-orange-500 border-orange-500 text-white'
                    : 'bg-white border-gray-300 text-gray-600 hover:border-orange-400',
                ].join(' ')}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {/* Saving indicator on its own row so it doesn't push button
              widths around when it appears. */}
          {saving && <p className="mt-2 text-xs text-gray-400">Saving…</p>}
        </>
      ) : (
        <p className="text-sm font-medium text-gray-800">{label}</p>
      )}
      {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
    </div>
  );
}
