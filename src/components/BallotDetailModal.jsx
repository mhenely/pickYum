import { useEffect, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { groupsApi } from '../lib/groupsApi';

// Shows the full ballot breakdown for a past (DONE) group event:
// - winner + method (vote / flip / spin) + voteMethod (simple / ranked) when applicable
// - per-voter ballots (approvals for simple, ordered rankings for ranked)
// - per-round IRV counts when ranked
//
// Backed by GET /api/groups/:id/events/:eventId which includes the full result
// row (ballots + irvRounds + scores + restaurantPool).

const METHOD_LABEL = {
  vote: '🗳 Vote',
  flip: '🪙 Coin flip',
  spin: '🎰 Roulette',
};

const VOTE_METHOD_LABEL = {
  simple: 'Simple Majority',
  ranked: 'Ranked-choice',
};

function poolItemName(pool, id) {
  const item = pool.find((p) => String(p.id) === String(id));
  return item?.name ?? id;
}

// Renders identity hints for a voter row based on voterMeta. The historical
// username is the snapshot at vote time; `currentUsername` is set by the
// server when the user has since renamed (server-side join via userId — the
// modal doesn't have to know about that). Cases handled:
//
//   - Guest                                  → "guest" italic
//   - Signed in, same name, no rename        → nothing
//   - Signed in, same name, renamed since    → "(now @new)"
//   - Signed in, different name, no rename   → "(signed in as @old)"
//   - Signed in, different name, renamed     → "(signed in as @old, now @new)"
//   - Legacy result (no meta / no username)  → nothing
function VoterIdentityBadge({ voterName, meta }) {
  if (!meta) return null;
  if (meta.isGuest) {
    return <span className="ml-1.5 text-[10px] uppercase tracking-wider text-gray-400 italic">guest</span>;
  }
  const historical = meta.username;
  const current    = meta.currentUsername; // set server-side ONLY when a rename happened
  if (!historical) return null;

  const differentDisplayName = historical !== voterName;
  if (!differentDisplayName && !current) return null;

  return (
    <span className="ml-1.5 text-xs font-normal text-gray-400">
      (
      {differentDisplayName && (
        <>signed in as <span className="font-mono">@{historical}</span></>
      )}
      {differentDisplayName && current && ', '}
      {current && (
        <>now <span className="font-mono">@{current}</span></>
      )}
      )
    </span>
  );
}

const BallotDetailModal = ({ groupId, eventId, onClose }) => {
  const [event, setEvent]   = useState(null);
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    groupsApi.getEvent(groupId, eventId)
      .then(({ event: e }) => { if (!cancelled) setEvent(e); })
      .catch((err) => { if (!cancelled) setError(err.message ?? 'Failed to load ballot detail'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [groupId, eventId]);

  const result = event?.result;
  const pool   = Array.isArray(result?.restaurantPool) ? result.restaurantPool : [];
  const ballots    = result?.ballots ?? null;
  const irvRounds  = Array.isArray(result?.irvRounds) ? result.irvRounds : null;
  const isRanked   = result?.voteMethod === 'ranked';
  const isSimple   = result?.voteMethod === 'simple';
  const scores     = result?.scores && typeof result.scores === 'object' ? result.scores : null;
  // voterMeta: { [displayName]: { isGuest, username } }. Missing on legacy
  // results (pre-migration) — we just render no extra badges in that case.
  const voterMeta  = result?.voterMeta && typeof result.voterMeta === 'object' ? result.voterMeta : null;
  const metaFor    = (name) => voterMeta?.[name] ?? null;

  return (
    <Dialog open onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4 overflow-y-auto">
        <DialogPanel className="w-full max-w-lg rounded-xl bg-white shadow-xl my-8">

          <div className="flex justify-between items-start p-6 pb-3 border-b border-gray-100">
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold text-gray-900">
                {event?.name ?? 'Vote detail'}
              </DialogTitle>
              {result && (
                <p className="text-xs text-gray-500 mt-0.5">
                  {new Date(result.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                </p>
              )}
            </div>
            <button onClick={onClose} className="ml-3 shrink-0 text-gray-400 hover:text-gray-600">
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          <div className="p-6 space-y-5">
            {loading && <p className="text-sm text-gray-400 text-center py-6">Loading ballot…</p>}
            {error && !loading && (
              <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
            )}
            {!loading && !error && !result && (
              <p className="text-sm text-gray-400 text-center py-6">No result recorded for this event.</p>
            )}

            {result && (
              <>
                {/* Winner banner */}
                <div className="rounded-xl bg-green-50 border border-green-200 p-4">
                  <p className="text-xs font-semibold text-green-700 uppercase tracking-wider mb-1">Winner</p>
                  <p className="text-xl font-black text-gray-900">{result.winnerName}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    Picked by {METHOD_LABEL[result.method] ?? result.method}
                    {result.voteMethod && ` · ${VOTE_METHOD_LABEL[result.voteMethod] ?? result.voteMethod}`}
                  </p>
                </div>

                {/* Participants. Pills show the historical display name + a
                    visible "→ @new" suffix when the user behind that name has
                    renamed since the event closed — keyed off voterMeta's
                    server-stamped currentUsername. */}
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    Participants ({result.participants.length})
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {result.participants.map((name) => {
                      const m = metaFor(name);
                      return (
                        <span
                          key={name}
                          className={`text-xs rounded-full px-2 py-0.5 border ${
                            m?.isGuest
                              ? 'bg-amber-50 border-amber-200 text-amber-700'
                              : 'bg-gray-100 border-gray-200 text-gray-700'
                          }`}
                          title={
                            m?.isGuest
                              ? 'Voted as a guest'
                              : m?.username && m.username !== name
                                ? (m?.currentUsername
                                    ? `Signed in as @${m.username} (now @${m.currentUsername})`
                                    : `Signed in as @${m.username}`)
                                : m?.currentUsername
                                  ? `Now @${m.currentUsername}`
                                  : ''
                          }
                        >
                          {name}{name === result.hostUsername ? ' 👑' : ''}
                          {m?.isGuest && <span className="ml-1 text-[9px] uppercase tracking-wide">guest</span>}
                          {m?.currentUsername && (
                            <span className="ml-1 text-gray-400">
                              → <span className="font-mono">@{m.currentUsername}</span>
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </div>

                {/* Aggregate scores (for any voting method) */}
                {scores && pool.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                      {isRanked ? 'Final round counts' : 'Vote totals'}
                    </p>
                    <ul className="space-y-1.5">
                      {pool
                        .slice()
                        .sort((a, b) => (Number(scores[b.id]) || 0) - (Number(scores[a.id]) || 0))
                        .map((item) => {
                          const count = Number(scores[item.id]) || 0;
                          const isWinner = item.name === result.winnerName;
                          return (
                            <li key={item.id} className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm ${
                              isWinner ? 'bg-green-100 border border-green-200 text-green-800 font-semibold' : 'bg-gray-50 border border-gray-100 text-gray-700'
                            }`}>
                              <span>{isWinner && '🏆 '}{item.name}</span>
                              <span className="text-xs">{count} {count === 1 ? 'vote' : 'votes'}</span>
                            </li>
                          );
                        })}
                    </ul>
                  </div>
                )}

                {/* Per-voter ballots — display varies by voteMethod */}
                {ballots && Object.keys(ballots).length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                      How each person voted
                    </p>
                    <div className="space-y-2">
                      {Object.entries(ballots).map(([voter, ballot]) => (
                        <div key={voter} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                          <p className="text-xs font-semibold text-gray-700 mb-1 flex items-baseline">
                            <span>{voter}{voter === result.hostUsername ? ' 👑' : ''}</span>
                            <VoterIdentityBadge voterName={voter} meta={metaFor(voter)} />
                          </p>
                          {isRanked && Array.isArray(ballot) ? (
                            // Ordered list of preferences. Empty array = abstained.
                            ballot.length === 0 ? (
                              <p className="text-xs text-gray-400 italic">No ranking submitted</p>
                            ) : (
                              <ol className="text-xs text-gray-600 space-y-0.5">
                                {ballot.map((id, idx) => (
                                  <li key={id}>
                                    <span className="font-mono text-orange-600 mr-1.5">#{idx + 1}</span>
                                    {poolItemName(pool, id)}
                                  </li>
                                ))}
                              </ol>
                            )
                          ) : isSimple && ballot && typeof ballot === 'object' ? (
                            // Approval map → list of approved restaurants
                            (() => {
                              const approved = Object.entries(ballot).filter(([, v]) => v === true).map(([id]) => id);
                              if (approved.length === 0) {
                                return <p className="text-xs text-gray-400 italic">Approved nothing</p>;
                              }
                              return (
                                <ul className="text-xs text-gray-600 space-y-0.5">
                                  {approved.map((id) => (
                                    <li key={id}>✓ {poolItemName(pool, id)}</li>
                                  ))}
                                </ul>
                              );
                            })()
                          ) : (
                            <p className="text-xs text-gray-400 italic">Ballot format not recognized</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* IRV round-by-round trace */}
                {isRanked && irvRounds && irvRounds.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                      Ranked-choice rounds
                    </p>
                    <div className="space-y-2">
                      {irvRounds.map((round, idx) => (
                        <div key={idx} className="rounded-lg border border-orange-100 bg-orange-50 px-3 py-2">
                          <p className="text-xs font-semibold text-orange-700 mb-1">Round {idx + 1}</p>
                          <ul className="text-xs text-gray-700 space-y-0.5">
                            {Object.entries(round.counts ?? {})
                              .sort(([, a], [, b]) => Number(b) - Number(a))
                              .map(([id, count]) => (
                                <li key={id} className="flex justify-between">
                                  <span>{poolItemName(pool, id)}</span>
                                  <span className="font-mono">{count}</span>
                                </li>
                              ))}
                          </ul>
                          {round.eliminated && (
                            <p className="text-xs text-red-600 mt-1.5">
                              ✕ Eliminated: <span className="font-medium">{poolItemName(pool, round.eliminated)}</span>
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!ballots && (
                  <p className="text-xs text-gray-400 italic">
                    Per-voter ballots weren't recorded for this event.
                  </p>
                )}
              </>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
};

export default BallotDetailModal;
