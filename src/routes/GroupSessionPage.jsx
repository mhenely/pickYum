import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { checkAuth } from '../redux/slices/authSlice';
import { addUserAcceptance } from '../redux/slices/userInfoSlice';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { sessionApi } from '../lib/sessionApi';
import { groupsApi } from '../lib/groupsApi';
import RouletteWheel from '../components/RouletteWheel';
import InfoRow from '../components/InfoRow';
import ScheduleModal from '../components/ScheduleModal';
import PublicRestaurantInfoModal from '../components/PublicRestaurantInfoModal';
import { PRICE_LABELS } from '../utils/restaurantConstants';
import { normalizeUrl } from '../utils/normalizeUrl';
import { buildGoogleCalendarUrl } from '../utils/calendarUtils';

const SSE_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

// ── Helpers ───────────────────────────────────────────────────

const sid = (id) => String(id);

const copyToClipboard = async (text) => {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
};

// ── Sub-views ─────────────────────────────────────────────────

const JoinView = ({ sessionId, session, onJoined, joinError, defaultName = '' }) => {
  const [name, setName] = useState(defaultName);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(joinError ?? '');

  const handle = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setLoading(true);
    setErr('');
    try {
      // If we have a stored token for this exact (session, name) — e.g. after a
      // refresh — replay it to re-attach. Without it, a new token is minted.
      const stored = sessionStorage.getItem(`py_voter_token_${sessionId}_${trimmed}`) ?? undefined;
      const { session: s, voterToken } = await sessionApi.join(sessionId, trimmed, stored);
      sessionStorage.setItem(`py_voter_${sessionId}`, trimmed);
      if (voterToken) {
        sessionStorage.setItem(`py_voter_token_${sessionId}_${trimmed}`, voterToken);
      }
      onJoined(trimmed, s, voterToken ?? stored ?? null);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
        <div className="text-4xl text-center mb-4">🍽️</div>
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-1">pickYum Group</h1>
        {session && (
          <p className="text-sm text-gray-500 text-center mb-6">
            {session.hostName} is deciding where to eat — join the vote!
          </p>
        )}
        <form onSubmit={handle} className="space-y-4">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            maxLength={30}
            autoFocus
            className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          {err && <p className="text-sm text-red-500">{err}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-orange-500 py-2.5 text-sm font-semibold text-white hover:bg-orange-500 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Joining…' : 'Join session'}
          </button>
        </form>
      </div>
    </div>
  );
};

// ── Lobby ─────────────────────────────────────────────────────

const LobbyView = ({ session, myName, isHost, onStart, onFlip, onSpin, onShowInfo, actionError }) => {
  const [copied, setCopied] = useState(false);
  const inviteUrl = `${window.location.origin}/vote/${session.id}`;

  const handleCopy = async () => {
    if (await copyToClipboard(inviteUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const voterNames = Object.keys(session.voters).filter((n) => n !== session.hostName);

  return (
    <div className="space-y-6">
      {/* Invite card */}
      <div className="bg-orange-50 border border-orange-100 rounded-xl p-5">
        <p className="text-xs font-semibold text-orange-500 uppercase tracking-wide mb-1">Session code</p>
        <p className="text-3xl font-black text-orange-700 tracking-widest mb-3">{session.id.toUpperCase()}</p>
        <button
          onClick={handleCopy}
          className="w-full rounded-lg border border-orange-300 bg-white px-3 py-2 text-sm font-medium text-orange-600 hover:bg-orange-50 transition-colors truncate"
        >
          {copied ? '✓ Link copied!' : `📋 Copy invite link`}
        </button>
      </div>

      {/* Candidate list */}
      <div>
        <p className="text-sm font-semibold text-gray-700 mb-2">
          Tonight's options ({session.candidates.length})
        </p>
        <ul className="space-y-1.5">
          {session.candidates.map((id) => {
            const r = session.restaurants[id];
            return (
              <li key={id} className="flex items-center gap-2 text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2">
                <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
                <span className="font-medium truncate min-w-0">{r?.name ?? id}</span>
                {r?.type && <span className="text-xs text-gray-400 shrink-0">· {r.type}</span>}
                {r?.price && <span className="text-xs text-gray-400 shrink-0">· {PRICE_LABELS[r.price]}</span>}
                {onShowInfo && (
                  <button
                    onClick={() => onShowInfo(id)}
                    aria-label="View restaurant details"
                    className="ml-auto shrink-0 w-6 h-6 rounded-full text-gray-400 hover:text-orange-600 hover:bg-orange-50 transition-colors flex items-center justify-center text-xs font-bold"
                  >
                    ℹ
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Who's joined */}
      <div>
        <p className="text-sm font-semibold text-gray-700 mb-2">
          Joined ({Object.keys(session.voters).length})
        </p>
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1 bg-orange-100 text-orange-700 text-xs font-semibold px-2.5 py-1 rounded-full">
            👑 {session.hostName}
          </span>
          {voterNames.map((n) => (
            <span key={n} className="inline-flex items-center bg-gray-100 text-gray-700 text-xs font-medium px-2.5 py-1 rounded-full">
              {n}
            </span>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-2">Share the invite link so others can join before voting starts.</p>
      </div>

      {/* Host controls */}
      {isHost && (
        <div className="border-t border-gray-100 pt-5 space-y-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Host controls</p>
          <button
            onClick={onStart}
            className="w-full rounded-lg bg-orange-500 py-2.5 text-sm font-semibold text-white hover:bg-orange-500 transition-colors"
          >
            Start voting →
          </button>
          <p className="text-xs text-gray-400 text-center">— or skip the vote and decide now —</p>
          <div className="flex gap-2">
            <button
              onClick={onFlip}
              className="flex-1 rounded-lg border border-gray-300 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              🪙 Coin Flip
            </button>
            <button
              onClick={onSpin}
              className="flex-1 rounded-lg border border-gray-300 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              🎰 Spin Roulette
            </button>
          </div>
          {actionError && <p className="text-sm text-red-500">{actionError}</p>}
        </div>
      )}

      {!isHost && (
        <p className="text-sm text-gray-400 italic text-center">
          Waiting for {session.hostName} to start the vote…
        </p>
      )}
    </div>
  );
};

// ── Voting ────────────────────────────────────────────────────

const VotingView = ({ session, myName, isHost, onSubmitVotes, onSubmitRanking, onClose, onShowInfo, actionError }) => {
  const isRanked = session.voteMethod === 'ranked';

  // SIMPLE ballot — approve/reject per candidate, default all-yes.
  const [ballot, setBallot] = useState(() => {
    const init = {};
    for (const id of session.candidates) init[id] = true;
    return init;
  });
  // RANKED ballot — ordered candidate IDs, default to the existing pool order.
  // Voter reorders via up/down buttons (more accessible than drag-and-drop and
  // works on mobile without extra dependencies).
  const [ranking, setRanking] = useState(() => [...session.candidates]);

  const [submitted, setSubmitted] = useState(session.submitted.includes(myName));

  const toggle = (id) => setBallot((prev) => ({ ...prev, [id]: !prev[id] }));

  const moveRank = (idx, delta) => {
    setRanking((prev) => {
      const target = idx + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const handleSubmit = async () => {
    if (isRanked) await onSubmitRanking(ranking);
    else          await onSubmitVotes(ballot);
    setSubmitted(true);
  };

  const voterList = [session.hostName, ...Object.keys(session.voters).filter((n) => n !== session.hostName)];
  const pendingCount = voterList.filter((n) => !session.submitted.includes(n)).length;

  if (submitted) {
    return (
      <div className="space-y-5">
        <div className="bg-green-50 border border-green-100 rounded-xl p-5 text-center">
          <p className="text-2xl mb-1">✓</p>
          <p className="font-semibold text-green-700">Votes submitted!</p>
          <p className="text-sm text-gray-500 mt-1">
            {pendingCount === 0 ? 'Everyone has voted.' : `Waiting for ${pendingCount} more…`}
          </p>
        </div>

        <div>
          <p className="text-sm font-semibold text-gray-700 mb-2">Status</p>
          <div className="space-y-1.5">
            {voterList.map((n) => (
              <div key={n} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">{n}{n === session.hostName ? ' 👑' : ''}{n === myName ? ' (you)' : ''}</span>
                {session.submitted.includes(n)
                  ? <span className="text-green-600 font-medium text-xs">Voted ✓</span>
                  : <span className="text-gray-400 text-xs">Pending…</span>}
              </div>
            ))}
          </div>
        </div>

        {isHost && (
          <div className="border-t border-gray-100 pt-4 space-y-2">
            <p className="text-xs text-gray-400">Don't want to wait for everyone?</p>
            <button
              onClick={onClose}
              className="w-full rounded-lg border border-gray-300 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Close voting now
            </button>
            {actionError && <p className="text-sm text-red-500">{actionError}</p>}
          </div>
        )}
      </div>
    );
  }

  const totalVoters = Object.keys(session.voters).length;
  const votedCount = session.submitted.length;
  const votePct = totalVoters > 0 ? Math.round((votedCount / totalVoters) * 100) : 0;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-lg font-bold text-gray-900">Cast your vote</p>
        <p className="text-sm text-gray-500">
          {isRanked
            ? 'Rank every restaurant from your favorite (top) to least preferred (bottom).'
            : "Approve the restaurants you're happy with."}
        </p>
      </div>

      {/* Live vote progress */}
      <div className="rounded-lg bg-gray-50 border border-gray-100 px-4 py-3">
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="text-gray-500 font-medium">Votes in</span>
          <span className="font-semibold text-gray-700">{votedCount} / {totalVoters}</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-1.5">
          <div
            className="bg-orange-400 h-1.5 rounded-full transition-all duration-500"
            style={{ width: `${votePct}%` }}
          />
        </div>
      </div>

      {isRanked ? (
        <ol className="space-y-2">
          {ranking.map((id, idx) => {
            const r = session.restaurants[id];
            return (
              <li key={id} className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 flex items-center gap-3">
                <span className="text-lg font-black text-orange-600 w-7 shrink-0">#{idx + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm text-gray-900 truncate">{r?.name ?? id}</p>
                  {r?.type && <p className="text-xs text-gray-400">{r.type}{r.price ? ` · ${PRICE_LABELS[r.price]}` : ''}</p>}
                </div>
                {onShowInfo && (
                  <button
                    onClick={() => onShowInfo(id)}
                    aria-label="View restaurant details"
                    className="shrink-0 w-7 h-7 rounded-full text-gray-400 hover:text-orange-600 hover:bg-white transition-colors flex items-center justify-center text-sm font-bold"
                  >
                    ℹ
                  </button>
                )}
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    onClick={() => moveRank(idx, -1)}
                    disabled={idx === 0}
                    aria-label="Move up"
                    className="rounded bg-white border border-orange-300 w-7 h-6 text-xs text-orange-600 hover:bg-orange-100 disabled:opacity-30"
                  >▲</button>
                  <button
                    onClick={() => moveRank(idx, 1)}
                    disabled={idx === ranking.length - 1}
                    aria-label="Move down"
                    className="rounded bg-white border border-orange-300 w-7 h-6 text-xs text-orange-600 hover:bg-orange-100 disabled:opacity-30"
                  >▼</button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <ul className="space-y-2">
          {session.candidates.map((id) => {
            const r = session.restaurants[id];
            const approved = ballot[id];
            // div+role rather than nested <button> so the inner ℹ︎ button is
            // semantically valid (HTML doesn't allow button-in-button) and the
            // info click doesn't fire the approve/reject toggle.
            return (
              <li key={id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(id); } }}
                  className={`w-full flex items-center justify-between rounded-xl border px-4 py-3 text-left cursor-pointer transition-all ${
                    approved
                      ? 'border-green-300 bg-green-50'
                      : 'border-gray-200 bg-white opacity-60'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-gray-900 truncate">{r?.name ?? id}</p>
                    {r?.type && <p className="text-xs text-gray-400 truncate">{r.type}{r.price ? ` · ${PRICE_LABELS[r.price]}` : ''}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {onShowInfo && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onShowInfo(id); }}
                        aria-label="View restaurant details"
                        className="w-7 h-7 rounded-full text-gray-400 hover:text-orange-600 hover:bg-white transition-colors flex items-center justify-center text-sm font-bold"
                      >
                        ℹ
                      </button>
                    )}
                    <span className={`text-xl ${approved ? 'text-green-500' : 'text-gray-300'}`}>
                      {approved ? '✓' : '✗'}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <button
        onClick={handleSubmit}
        className="w-full rounded-lg bg-orange-500 py-2.5 text-sm font-semibold text-white hover:bg-orange-500 transition-colors"
      >
        Submit {isRanked ? 'ranking' : 'votes'}
      </button>
    </div>
  );
};

// ── Tie break ─────────────────────────────────────────────────

const TieBreakView = ({ session, isHost, onFlip, onSpin, onShowInfo, actionError }) => {
  const totalVoters = Object.keys(session.voters).length;
  const maxScore = session.scores ? Math.max(...Object.values(session.scores)) : 0;

  return (
    <div className="space-y-5">
      <div className="text-center">
        <p className="text-3xl mb-1">🤝</p>
        <p className="text-xl font-bold text-gray-900">It's a tie!</p>
        <p className="text-sm text-gray-500">{session.tiedIds?.length} restaurants are tied — the host will break it.</p>
      </div>

      {/* Full score breakdown */}
      <div>
        <p className="text-sm font-semibold text-gray-700 mb-3">Vote results</p>
        <ul className="space-y-2">
          {session.candidates
            .slice()
            .sort((a, b) => (session.scores?.[b] ?? 0) - (session.scores?.[a] ?? 0))
            .map((id) => {
              const r = session.restaurants[id];
              const score = session.scores?.[id] ?? 0;
              const isTied = session.tiedIds?.includes(id);
              const pct = totalVoters > 0 ? (score / totalVoters) * 100 : 0;
              return (
                <li key={id} className={`rounded-xl border px-4 py-3 ${isTied ? 'border-amber-300 bg-amber-50' : 'border-gray-100 bg-gray-50'}`}>
                  <div className="flex justify-between items-center mb-1.5 gap-2">
                    <span className="font-semibold text-sm text-gray-900 truncate min-w-0">
                      {isTied && '🏅 '}{r?.name ?? id}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      {onShowInfo && (
                        <button
                          onClick={() => onShowInfo(id)}
                          aria-label="View restaurant details"
                          className="w-6 h-6 rounded-full text-gray-400 hover:text-orange-600 hover:bg-white transition-colors flex items-center justify-center text-xs font-bold"
                        >
                          ℹ
                        </button>
                      )}
                      <span className={`text-xs font-bold ${isTied ? 'text-amber-700' : 'text-gray-500'}`}>
                        {score}/{totalVoters}
                      </span>
                    </div>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
                    <div
                      className={`h-1.5 rounded-full transition-all ${isTied ? 'bg-amber-400' : 'bg-gray-300'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </li>
              );
            })}
        </ul>
      </div>

      {isHost && (
        <div className="border-t border-gray-100 pt-4 space-y-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Break the tie</p>
          <div className="flex gap-2">
            <button
              onClick={onFlip}
              className="flex-1 rounded-lg bg-orange-500 py-2.5 text-sm font-semibold text-white hover:bg-orange-500 transition-colors"
            >
              🪙 Coin Flip
            </button>
            <button
              onClick={onSpin}
              className="flex-1 rounded-lg border border-orange-300 py-2.5 text-sm font-semibold text-orange-600 hover:bg-orange-50 transition-colors"
            >
              🎰 Spin Roulette
            </button>
          </div>
          {actionError && <p className="text-sm text-red-500">{actionError}</p>}
        </div>
      )}

      {!isHost && (
        <p className="text-sm text-gray-400 italic text-center">
          Waiting for {session.hostName} to break the tie…
        </p>
      )}
    </div>
  );
};

// ── Result ────────────────────────────────────────────────────

const ResultView = ({ session, isHost, onAccept, onRedo, onReject }) => {
  const [copied, setCopied] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const winner = session.result ? session.restaurants[session.result] : null;
  const totalVoters = Object.keys(session.voters).length;

  // Host can reject the current winner and retry with the remaining pool.
  // Disabled when removing one would leave only 1 candidate left.
  const canReject = session.candidates.length > 2;
  const handleReject = () => {
    if (!onReject) return;
    const winnerName = winner?.name ?? 'this option';
    if (window.confirm(`Reject ${winnerName} and retry with the remaining ${session.candidates.length - 1} restaurants?`)) {
      onReject();
    }
  };

  const scheduledDefaults = (() => {
    if (!session.scheduledFor) return { defaultDate: undefined, defaultTime: undefined };
    const d = new Date(session.scheduledFor);
    return {
      defaultDate: d.toISOString().slice(0, 10),
      defaultTime: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    };
  })();

  const buildShareUrl = () => {
    if (!winner) return window.location.href;
    const start = session.scheduledFor ? new Date(session.scheduledFor) : new Date();
    const end = new Date(start.getTime() + 90 * 60_000);
    return buildGoogleCalendarUrl({
      title: `Dinner at ${winner.name}`,
      startDate: start,
      endDate: end,
      description: 'Decided by pickYum group vote',
    });
  };

  const handleShare = async () => {
    const name = winner?.name ?? 'a restaurant';
    const text = `pickYum's group vote chose ${name} for us!${session.scheduledFor ? ` (${new Date(session.scheduledFor).toLocaleString()})` : ''}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'pickYum', text, url: buildShareUrl() }); } catch { /* cancelled */ }
    } else {
      if (await copyToClipboard(text)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    }
  };

  return (
    <div className="space-y-6 text-center">
      <div>
        <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-1">Tonight you're going to</p>
        <div className="bg-green-50 border border-green-200 rounded-2xl px-6 py-5 mt-2">
          <p className="text-3xl font-black text-gray-900">{winner?.name ?? session.result}</p>
          {winner && (
            <p className="text-sm text-gray-500 mt-1">
              {winner.type}
              {winner.price ? ` · ${PRICE_LABELS[winner.price]}` : ''}
            </p>
          )}
        </div>
      </div>

      {session.scores && (
        <div className="text-left">
          <p className="text-sm font-semibold text-gray-700 mb-3">Final scores</p>
          <ul className="space-y-2">
            {session.candidates
              .slice()
              .sort((a, b) => (session.scores[b] ?? 0) - (session.scores[a] ?? 0))
              .map((id) => {
                const r = session.restaurants[id];
                const score = session.scores[id] ?? 0;
                const isWinner = sid(id) === sid(session.result);
                const pct = totalVoters > 0 ? (score / totalVoters) * 100 : 0;
                return (
                  <li key={id} className={`rounded-xl border px-4 py-2.5 ${isWinner ? 'border-green-300 bg-green-50' : 'border-gray-100 bg-gray-50'}`}>
                    <div className="flex justify-between items-center mb-1">
                      <span className={`font-medium text-sm ${isWinner ? 'text-green-800' : 'text-gray-700'}`}>
                        {isWinner && '🏆 '}{r?.name ?? id}
                      </span>
                      <span className="text-xs text-gray-500">{score}/{totalVoters}</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-1.5">
                      <div
                        className={`h-1.5 rounded-full ${isWinner ? 'bg-green-500' : 'bg-gray-300'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
          </ul>
        </div>
      )}

      {isHost ? (
        <div className="space-y-2">
          <div className="flex gap-3">
            <button
              onClick={onAccept}
              className="flex-1 rounded-lg bg-green-600 py-2.5 text-sm font-semibold text-white hover:bg-green-500 transition-colors"
            >
              Accept — Let's go!
            </button>
            <button
              onClick={onRedo}
              className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Redo
            </button>
          </div>
          <button
            onClick={handleReject}
            disabled={!canReject}
            title={canReject ? '' : 'Need at least 3 candidates to reject and retry'}
            className="w-full rounded-lg border border-red-200 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ✕ Reject &amp; remove this restaurant
          </button>
        </div>
      ) : (
        <div className="flex gap-3">
          <button
            onClick={() => setShowSchedule(true)}
            className="flex-1 rounded-lg border border-orange-200 py-2.5 text-sm font-medium text-orange-600 hover:bg-orange-50 transition-colors"
          >
            📅 Add to Calendar
          </button>
          <button
            onClick={handleShare}
            className="flex-1 rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
          >
            {copied ? '✓ Copied!' : '↗ Share'}
          </button>
        </div>
      )}

      {showSchedule && winner && (
        <ScheduleModal
          restaurantName={winner.name}
          defaultDate={scheduledDefaults.defaultDate}
          defaultTime={scheduledDefaults.defaultTime}
          onClose={() => setShowSchedule(false)}
        />
      )}
    </div>
  );
};

// ── Group winner modal ────────────────────────────────────────

const GroupWinnerModal = ({ session, onClose, onAccept }) => {
  const customRestaurants = useSelector((state) => state.userInfo?.customRestaurants ?? {});
  const userInfo = useSelector((state) => state.userInfo?.users?.[0]);
  const [copied, setCopied] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);

  const id = session.result;
  const snap = id ? session.restaurants[id] : null;
  const full = id ? (customRestaurants[id] ?? null) : null;
  const r = full ?? snap;

  if (!r) return null;

  const scheduledDefaults = (() => {
    if (!session.scheduledFor) return { defaultDate: undefined, defaultTime: undefined };
    const d = new Date(session.scheduledFor);
    return {
      defaultDate: d.toISOString().slice(0, 10),
      defaultTime: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    };
  })();

  const reviews = userInfo?.reviews?.[String(id)] ?? [];
  const avgRating = reviews.length
    ? reviews.reduce((acc, rv) => acc + rv.rating, 0) / reviews.length
    : null;

  const buildShareUrl = () => {
    const start = session.scheduledFor ? new Date(session.scheduledFor) : new Date();
    const end = new Date(start.getTime() + 90 * 60_000);
    return buildGoogleCalendarUrl({
      title: `Dinner at ${r.name}`,
      startDate: start,
      endDate: end,
      description: `Address: ${full?.address ?? 'see restaurant details'}\n\nDecided by pickYum group vote`,
    });
  };

  const handleShare = async () => {
    const lines = [`pickYum's group vote chose ${r.name}!`];
    if (session.scheduledFor) lines.push(`When: ${new Date(session.scheduledFor).toLocaleString()}`);
    if (full?.address) lines.push(`Where: ${full.address}`);
    if (full?.website) lines.push(`Website: ${full.website}`);
    const text = lines.join('\n');
    if (navigator.share) {
      try { await navigator.share({ title: 'pickYum', text, url: buildShareUrl() }); } catch { /* cancelled */ }
    } else {
      if (await copyToClipboard(text)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    }
  };

  return (
    <>
    <Dialog open onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-lg rounded-xl bg-white shadow-xl flex flex-col max-h-[85vh] overflow-y-auto">

          <div className="bg-green-50 border-b border-green-100 px-6 py-4 flex justify-between items-start rounded-t-xl">
            <div>
              <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-0.5">Tonight you're going to</p>
              <DialogTitle className="text-2xl font-bold text-gray-900">{r.name}</DialogTitle>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 shrink-0 mt-1">
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          <div className="px-6 py-5 flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              {r.type && (
                <span className="px-2.5 py-0.5 rounded-full bg-orange-100 text-orange-700 text-xs font-semibold">{r.type}</span>
              )}
              {full?.rating != null && (
                <span className="text-xs font-semibold text-amber-500">★ {full.rating} Google</span>
              )}
              {avgRating != null && (
                <span className="text-xs font-semibold text-orange-500">★ {avgRating.toFixed(1)} You</span>
              )}
            </div>

            <hr className="border-gray-100" />

            <div className="grid grid-cols-2 gap-x-8 gap-y-4">
              {r.price && <InfoRow label="Price" value={PRICE_LABELS[r.price]} />}
              {full?.hours && <InfoRow label="Opens" value={full.hours} />}
              {full?.phone && <InfoRow label="Phone" value={full.phone} href={`tel:${full.phone}`} />}
              {full?.website && <InfoRow label="Website" value={full.website} href={normalizeUrl(full.website)} external />}
              {full?.yelp && <InfoRow label="Yelp" value={full.yelp} href={normalizeUrl(full.yelp)} external />}
            </div>

            {(full?.takeout != null || full?.delivery != null) && (
              <div className="flex gap-2">
                <span className={`px-3 py-1 rounded-full text-xs font-semibold ${full.takeout ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400 line-through'}`}>
                  Takeout
                </span>
                <span className={`px-3 py-1 rounded-full text-xs font-semibold ${full.delivery ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400 line-through'}`}>
                  Delivery
                </span>
              </div>
            )}

            {reviews.length > 0 && (
              <div className="border-t border-gray-100 pt-4">
                <p className="text-sm font-semibold text-gray-700 mb-3">
                  Your Reviews
                  <span className="ml-1.5 text-xs font-normal text-gray-400">({reviews.length})</span>
                </p>
                <div className="flex flex-col gap-2 max-h-44 overflow-y-auto pr-1">
                  {reviews.map((rv) => (
                    <div key={rv.content + rv.date} className="rounded-lg bg-gray-50 px-3 py-2.5">
                      <div className="flex justify-between items-center mb-0.5">
                        <span className="text-xs font-bold text-amber-500">★ {rv.rating}</span>
                        <span className="text-xs text-gray-400">{rv.date}</span>
                      </div>
                      <p className="text-xs text-gray-600 leading-relaxed">{rv.content}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={onAccept ?? onClose}
                className="flex-1 rounded-lg bg-green-600 py-2.5 text-sm font-semibold text-white hover:bg-green-500 transition-colors"
              >
                Let's go!
              </button>
              <button
                onClick={() => setShowSchedule(true)}
                className="rounded-lg border border-orange-200 px-4 py-2.5 text-sm font-medium text-orange-600 hover:bg-orange-50 transition-colors shrink-0"
                title="Add to calendar"
              >
                📅 Schedule
              </button>
              <button
                onClick={handleShare}
                className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors shrink-0"
              >
                {copied ? '✓ Copied!' : '↗ Share'}
              </button>
            </div>
          </div>
        </DialogPanel>
      </div>
    </Dialog>

    {showSchedule && (
      <ScheduleModal
        restaurantName={r.name}
        defaultDate={scheduledDefaults.defaultDate}
        defaultTime={scheduledDefaults.defaultTime}
        onClose={() => setShowSchedule(false)}
      />
    )}
    </>
  );
};

// ── Roulette animation overlay ────────────────────────────────

const RouletteOverlay = ({ winnerId, pool, restaurants, onComplete }) => {
  const wheelRef = useRef(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      wheelRef.current?.spinTo(winnerId, pool);
    }, 300);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleComplete = () => {
    setDone(true);
    setTimeout(onComplete, 1200);
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-950 flex flex-col items-center justify-center gap-4 p-4">
      <p className="text-white font-bold text-lg">{done ? '🎉 We have a winner!' : '🎰 Spinning…'}</p>
      <RouletteWheel
        ref={wheelRef}
        options={pool}
        restaurants={restaurants}
        onSpinComplete={handleComplete}
      />
    </div>
  );
};

// ── Coin flip animation overlay ───────────────────────────────

const CoinFlipOverlay = ({ onComplete }) => {
  const [phase, setPhase] = useState('spinning'); // spinning | done

  useEffect(() => {
    const t = setTimeout(() => { setPhase('done'); setTimeout(onComplete, 800); }, 2200);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-50 bg-gray-950 flex flex-col items-center justify-center gap-6">
      <p className="text-white font-bold text-xl">{phase === 'done' ? '🎉 Decided!' : '🪙 Flipping…'}</p>
      <div
        className="w-24 h-24 rounded-full flex items-center justify-center text-5xl shadow-2xl"
        style={{
          background: 'linear-gradient(135deg, #fbbf24, #f59e0b)',
          animation: phase === 'spinning' ? 'spin 0.4s linear infinite' : 'none',
        }}
      >
        🪙
      </div>
      <style>{`@keyframes spin { to { transform: rotateY(360deg); } }`}</style>
    </div>
  );
};

// ── Page ──────────────────────────────────────────────────────

const GroupSessionPage = () => {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const authUsername = useSelector((state) => state.auth?.user?.username ?? '');
  const authUserId   = useSelector((state) => state.auth?.user?.id ?? null);

  // This page opens in a new tab outside <App />, so checkAuth never ran — restore it now
  useEffect(() => { dispatch(checkAuth()); }, [dispatch]);

  const [session, setSession]   = useState(null);
  const [myName, setMyName]     = useState(() => sessionStorage.getItem(`py_voter_${sessionId}`) ?? '');
  // Per-voter capability minted at /join. Required on every /vote call for
  // non-host voters; the host bypasses by virtue of their JWT cookie. Restored
  // from sessionStorage on mount so a refresh doesn't kick the user back to
  // the join screen with a name nobody owns the token for.
  const [myVoterToken, setMyVoterToken] = useState(() => {
    const name = sessionStorage.getItem(`py_voter_${sessionId}`);
    return name ? sessionStorage.getItem(`py_voter_token_${sessionId}_${name}`) : null;
  });
  const [fetchError, setFetchError] = useState('');
  const [actionError, setActionError] = useState('');

  // Overlay state for animations
  const [showCoin, setShowCoin]         = useState(false);
  const [showRoulette, setShowRoulette] = useState(false);
  const roulettePool      = useRef([]);
  const rouletteWinnerId  = useRef(null);
  const pendingSession    = useRef(null);

  // Winner modal (host accept flow)
  const [showWinnerModal, setShowWinnerModal] = useState(false);

  // Restaurant-info modal — set to a restaurantId to open it, null to close.
  // Lives at the page level so any view (lobby / voting / tiebreak / result)
  // can open it via the same handler passed down as a prop.
  const [infoForId, setInfoForId] = useState(null);

  // Track previous session + overlay state via refs so applySession can stay
  // dep-free (otherwise it would re-create on every overlay toggle and tear
  // down the SSE EventSource).
  const sessionRef      = useRef(null);
  const showCoinRef     = useRef(false);
  const showRouletteRef = useRef(false);
  useEffect(() => { showCoinRef.current     = showCoin;     }, [showCoin]);
  useEffect(() => { showRouletteRef.current = showRoulette; }, [showRoulette]);

  // Apply incoming session updates. When `result` newly appears (host triggered
  // flip/spin), play the same overlay locally so every voter sees the reveal,
  // not just the outcome. Skips if a local overlay is already running so the
  // host's own animation isn't restarted.
  const applySession = useCallback((s) => {
    const prev = sessionRef.current;
    sessionRef.current = s;

    const justGotResult = prev != null && !prev.result && !!s.result;
    if (justGotResult) {
      if (s.method === 'flip' && !showCoinRef.current) {
        pendingSession.current = s;
        setShowCoin(true);
      } else if (s.method === 'spin' && !showRouletteRef.current) {
        roulettePool.current     = s.tiedIds ?? s.candidates;
        rouletteWinnerId.current = s.result;
        pendingSession.current   = s;
        setShowRoulette(true);
      }
    }

    setSession(s);
  }, []);

  // Auto-join authenticated users so they skip the name form.
  // The host is already registered in the session — skip the join API call for them.
  useEffect(() => {
    if (myName || !authUsername || !session || session.status === 'done') return;
    if (authUsername === session.hostName) {
      sessionStorage.setItem(`py_voter_${sessionId}`, authUsername);
      setMyName(authUsername);
      // Host doesn't need a voter token — their JWT cookie auths the /vote.
      return;
    }
    const stored = sessionStorage.getItem(`py_voter_token_${sessionId}_${authUsername}`) ?? undefined;
    sessionApi.join(sessionId, authUsername, stored)
      .then(({ session: s, voterToken }) => {
        sessionStorage.setItem(`py_voter_${sessionId}`, authUsername);
        if (voterToken) {
          sessionStorage.setItem(`py_voter_token_${sessionId}_${authUsername}`, voterToken);
          setMyVoterToken(voterToken);
        } else if (stored) {
          setMyVoterToken(stored);
        }
        setMyName(authUsername);
        applySession(s);
      })
      .catch(() => {}); // fail silently — JoinView shows as fallback
  }, [myName, authUsername, session, sessionId, applySession]);

  // ── SSE stream ────────────────────────────────────────────────
  useEffect(() => {
    if (!myName || !sessionId) return;

    const es = new EventSource(`${SSE_BASE}/api/sessions/${sessionId}/stream`);

    es.onmessage = (e) => {
      try { applySession(JSON.parse(e.data)); } catch { /* ignore parse errors */ }
    };

    es.addEventListener('close', () => {
      es.close();
      setFetchError('Session expired');
    });

    es.onerror = () => {
      setFetchError('Lost connection to session');
      es.close();
    };

    return () => es.close();
  }, [myName, sessionId, applySession]);

  // Initial fetch for the join screen (before name is set)
  useEffect(() => {
    if (myName) return;
    sessionApi.get(sessionId)
      .then(({ session: s }) => applySession(s))
      .catch(() => {}); // silently ignore — join view shows code anyway
  }, [sessionId, myName, applySession]);

  const isHost = session ? myName === session.hostName : false;

  // Record acceptance in local state for non-host authenticated users when result arrives
  const acceptedDispatchedRef = useRef(false);
  useEffect(() => {
    if (
      !session || session.status !== 'done' || isHost ||
      !authUserId || !session.result || acceptedDispatchedRef.current
    ) return;
    acceptedDispatchedRef.current = true;
    // _serverHandled tells the listener not to POST to /me/accepted — the
    // host's accept-result endpoint will (or already did) write the row with
    // optionsSnapshot + chooseMethod. We still dispatch so local Redux
    // state shows the acceptance immediately for the non-host UX.
    dispatch(addUserAcceptance({
      restaurantId: Number(session.result),
      _serverHandled: true,
    }));
  }, [session?.status, isHost, authUserId, session?.result, dispatch]);

  // ── Actions ──────────────────────────────────────────────────
  const withAction = (fn) => async (...args) => {
    setActionError('');
    try {
      const { session: s } = await fn(...args);
      applySession(s);
    } catch (err) {
      setActionError(err.message);
    }
  };

  const handleStart = withAction(() => sessionApi.start(sessionId));

  const handleFlip = async () => {
    setActionError('');
    try {
      setShowCoin(true);
      const { session: s } = await sessionApi.flip(sessionId, 'flip');
      pendingSession.current = s; // applied in onComplete, not before
    } catch (err) {
      setShowCoin(false);
      setActionError(err.message);
    }
  };

  const handleSpin = async () => {
    setActionError('');
    try {
      const pool = session.tiedIds ?? session.candidates;
      const { session: s } = await sessionApi.flip(sessionId, 'spin');
      roulettePool.current     = pool;
      rouletteWinnerId.current = s.result;
      pendingSession.current   = s; // applied in onComplete, not before
      setShowRoulette(true);
    } catch (err) {
      setActionError(err.message);
    }
  };

  const handleAcceptResult = async () => {
    if (session?.groupId && session?.eventId) {
      try { await groupsApi.acceptResult(session.groupId, session.eventId); } catch { /* non-fatal */ }
    }
    if (session?.result && authUserId) {
      // accept-result on the server already wrote the host's UserAccepted row
      // with optionsSnapshot + chooseMethod — _serverHandled tells the
      // listener to skip the duplicate POST. Local Redux state still updates
      // immediately so the user sees their acceptance in history right away.
      dispatch(addUserAcceptance({
        restaurantId: Number(session.result),
        _serverHandled: true,
      }));
    }
    navigate('/socials');
  };

  const handleSubmitVotes   = withAction((ballot)  => sessionApi.vote(sessionId, myName, ballot, myVoterToken));
  const handleSubmitRanking = withAction((ranking) => sessionApi.voteRanked(sessionId, myName, ranking, myVoterToken));
  const handleCloseVoting   = withAction(() => sessionApi.close(sessionId));

  const handleAccept = () => setShowWinnerModal(true);
  const handleRedo   = withAction(() => sessionApi.redo(sessionId));
  // Host rejects the current winner — server drops the restaurant from
  // candidates and resets to lobby. Caller picks the next vote/flip/spin.
  const handleReject = withAction(() => sessionApi.reject(sessionId));

  // ── Render ────────────────────────────────────────────────────
  if (!myName) {
    return (
      <JoinView
        sessionId={sessionId}
        session={session}
        onJoined={(name, s, token) => {
          setMyName(name);
          if (token) setMyVoterToken(token);
          applySession(s);
        }}
        joinError={fetchError}
        defaultName={authUsername}
      />
    );
  }

  if (fetchError && !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="text-center">
          <p className="text-2xl mb-2">😕</p>
          <p className="font-semibold text-gray-700 mb-1">Session not found</p>
          <p className="text-sm text-gray-400 mb-4">{fetchError}</p>
          <button onClick={() => navigate('/')} className="text-sm text-orange-600 hover:underline">
            Go home
          </button>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-400 text-sm animate-pulse">Loading session…</p>
      </div>
    );
  }

  const renderContent = () => {
    switch (session.status) {
      case 'lobby':
        return (
          <LobbyView
            session={session}
            myName={myName}
            isHost={isHost}
            onStart={handleStart}
            onFlip={handleFlip}
            onSpin={handleSpin}
            onShowInfo={setInfoForId}
            actionError={actionError}
          />
        );
      case 'voting':
        return (
          <VotingView
            session={session}
            myName={myName}
            isHost={isHost}
            onSubmitVotes={handleSubmitVotes}
            onSubmitRanking={handleSubmitRanking}
            onClose={handleCloseVoting}
            onShowInfo={setInfoForId}
            actionError={actionError}
          />
        );
      case 'closed':
        return (
          <TieBreakView
            session={session}
            isHost={isHost}
            onFlip={handleFlip}
            onSpin={handleSpin}
            onShowInfo={setInfoForId}
            actionError={actionError}
          />
        );
      case 'done':
        return (
          <ResultView
            session={session}
            isHost={isHost}
            onAccept={handleAccept}
            onRedo={handleRedo}
            onReject={handleReject}
          />
        );
      default:
        return null;
    }
  };

  return (
    <>
      {showCoin && (
        <CoinFlipOverlay
          onComplete={() => {
            setShowCoin(false);
            if (pendingSession.current) {
              applySession(pendingSession.current);
              pendingSession.current = null;
            }
          }}
        />
      )}

      {showRoulette && (
        <RouletteOverlay
          winnerId={rouletteWinnerId.current}
          pool={roulettePool.current}
          restaurants={session.restaurants}
          onComplete={() => {
            setShowRoulette(false);
            if (pendingSession.current) {
              applySession(pendingSession.current);
              pendingSession.current = null;
            }
          }}
        />
      )}

      {showWinnerModal && session.result && (
        <GroupWinnerModal
          session={session}
          onClose={() => setShowWinnerModal(false)}
          onAccept={handleAcceptResult}
        />
      )}

      {infoForId && (
        <PublicRestaurantInfoModal
          restaurantId={Number(infoForId)}
          // Pass the session snapshot so the modal shows name/type/price
          // immediately while it fetches the full restaurant detail.
          fallback={session.restaurants[infoForId]}
          onClose={() => setInfoForId(null)}
        />
      )}

      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <a href="/" className="text-lg font-black text-orange-600 hover:text-orange-500 transition-colors">pickYum</a>
            <span className="text-gray-300">|</span>
            <span className="text-sm text-gray-500">Group vote</span>
          </div>
          <span className="text-xs font-mono text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
            {session.id.toUpperCase()}
          </span>
        </div>

        {/* Body */}
        <div className="mx-auto max-w-lg px-4 py-6">
          {renderContent()}
        </div>
      </div>
    </>
  );
};

export default GroupSessionPage;
