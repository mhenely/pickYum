// Archived event result panel — winner card, vote bars, calendar export,
// "Add to Options" affordance. Extracted from GroupDetailPage so the
// route file isn't carrying 250 lines of result-presentation logic.

import { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { addUserOption, addCustomRestaurant } from '../../redux/slices/userInfoSlice';
import { normalizeUrl } from '../../utils/normalizeUrl';

// Frozen sentinels so useSelector fallbacks don't produce a fresh
// reference on every dispatch (re-renders the consumer for no reason).
const EMPTY_ARRAY = Object.freeze([]);
const EMPTY_OBJECT = Object.freeze({});

export default function ResultDisplay({ result, scheduledFor }) {
  const dispatch = useDispatch();
  const userOptions    = useSelector((s) => s.userInfo.user?.options ?? EMPTY_ARRAY);
  const customRestaurants = useSelector((s) => s.userInfo.customRestaurants ?? EMPTY_OBJECT);

  const [shared, setShared] = useState(false);
  const [localDate, setLocalDate] = useState(
    scheduledFor ? new Date(scheduledFor).toISOString().slice(0, 16) : ''
  );

  useEffect(() => {
    if (scheduledFor) setLocalDate(new Date(scheduledFor).toISOString().slice(0, 16));
  }, [scheduledFor]);

  const methodLabel = result.method === 'spin' ? '🎰 Roulette' : result.method === 'flip' ? '🪙 Coin Flip' : '🗳 Vote';
  const pool = Array.isArray(result.restaurantPool) ? result.restaurantPool : [];
  const scores = result.scores && typeof result.scores === 'object' ? result.scores : null;
  const maxVotes = scores ? Math.max(...Object.values(scores).map(Number), 1) : 1;

  const winner = pool.find((item) => item.name === result.winnerName);
  const winnerAddress = winner?.address ?? null;
  const winnerWebsite = winner?.website ?? null;

  const fmtIcs = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const buildGCalUrl = () => {
    const params = new URLSearchParams({ action: 'TEMPLATE', text: `Dinner at ${result.winnerName}` });
    if (localDate) {
      const start = new Date(localDate);
      const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
      params.set('dates', `${fmtIcs(start)}/${fmtIcs(end)}`);
    }
    if (winnerAddress) params.set('location', winnerAddress);
    const details = [winnerWebsite].filter(Boolean).join('\n');
    if (details) params.set('details', details);
    return `https://www.google.com/calendar/render?${params.toString()}`;
  };

  const handleShare = async () => {
    const lines = [
      `We're going to ${result.winnerName}!`,
      localDate ? `When: ${new Date(localDate).toLocaleString()}` : null,
      winnerAddress ? `Where: ${winnerAddress}` : null,
      winnerWebsite ?? null,
    ].filter(Boolean);
    const calUrl = buildGCalUrl();
    try {
      if (navigator.share) {
        await navigator.share({
          title: `Dinner at ${result.winnerName}`,
          text: lines.join('\n'),
          url: calUrl,
        });
      } else {
        await navigator.clipboard.writeText([...lines, calUrl].join('\n'));
        setShared(true);
        setTimeout(() => setShared(false), 2500);
      }
    } catch { /* user cancelled or not supported */ }
  };

  const isWinnerInOptions = winner ? userOptions.some((s) => String(s) === String(winner.id)) : false;

  const handleAddToOptions = () => {
    if (!winner) return;
    const id = String(winner.id);
    if (!customRestaurants[id]) {
      dispatch(addCustomRestaurant({
        id,
        data: {
          name: winner.name,
          type: winner.type ?? 'Restaurant',
          price: winner.price ?? 1,
          rating: null,
          hours: 'N/A',
          phone: 'N/A',
          website: winner.website ?? 'N/A',
          address: winner.address ?? null,
          yelp: 'N/A',
          takeout: false,
          delivery: false,
        },
      }));
    }
    dispatch(addUserOption(id));
  };

  // `noopener,noreferrer` strips window.opener so the newly opened tab can't
  // navigate this one (reverse tabnabbing). Match the pattern used in
  // ScheduleModal which has the same external-link concern.
  const handleGoogleCalendar = () => window.open(buildGCalUrl(), '_blank', 'noopener,noreferrer');

  const handleAppleCalendar = () => {
    if (!localDate) return;
    const start = new Date(localDate);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//PickYum//EN',
      'BEGIN:VEVENT',
      `DTSTART:${fmtIcs(start)}`,
      `DTEND:${fmtIcs(end)}`,
      `SUMMARY:Dinner at ${result.winnerName}`,
      winnerAddress ? `LOCATION:${winnerAddress}` : null,
      winnerWebsite ? `DESCRIPTION:${winnerWebsite}` : null,
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');
    const blob = new Blob([ics], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.winnerName.replace(/[^a-z0-9]/gi, '_')}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-xl border border-green-200 bg-green-50 p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="text-2xl">🏆</span>
        <div className="min-w-0">
          <p className="text-lg font-bold text-gray-900">{result.winnerName}</p>
          {winnerAddress && <p className="text-xs text-gray-500 mt-0.5">{winnerAddress}</p>}
          {winnerWebsite && normalizeUrl(winnerWebsite) && (
            <a href={normalizeUrl(winnerWebsite)}
              target="_blank" rel="noopener noreferrer"
              className="text-xs text-orange-600 hover:text-orange-500 transition-colors">
              {winnerWebsite}
            </a>
          )}
          <p className="text-xs text-gray-500 mt-0.5">
            {methodLabel} · {new Date(result.createdAt).toLocaleDateString()}
          </p>
          <p className="text-xs text-gray-500">
            {/* The host label is the historical username at result time. If
                the user has since renamed, the server stamps a currentUsername
                onto voterMeta[hostUsername] which we surface inline as
                "(now @new)" without rewriting history. */}
            Host: {result.hostUsername}
            {(() => {
              const meta = result.voterMeta && typeof result.voterMeta === 'object'
                ? result.voterMeta[result.hostUsername]
                : null;
              return meta?.currentUsername ? (
                <span className="text-gray-400"> (now <span className="font-mono">@{meta.currentUsername}</span>)</span>
              ) : null;
            })()}
            {' '}· {result.participants.length} participant{result.participants.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {result.participants.map((name) => {
          // Same rename logic as the host label — look up voterMeta entry for
          // this display name. If the user behind it has renamed since, append
          // their current username inline so the pill reads e.g.
          // "Matt 👑 → @matthew_h" at a glance.
          const meta = result.voterMeta && typeof result.voterMeta === 'object'
            ? result.voterMeta[name]
            : null;
          return (
            <span
              key={name}
              className="text-xs bg-white border border-gray-200 rounded-full px-2 py-0.5 text-gray-600"
              title={meta?.currentUsername ? `Now @${meta.currentUsername}` : ''}
            >
              {name}{name === result.hostUsername ? ' 👑' : ''}
              {meta?.currentUsername && (
                <span className="ml-1 text-gray-400">
                  → <span className="font-mono">@{meta.currentUsername}</span>
                </span>
              )}
            </span>
          );
        })}
      </div>

      {scores && pool.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Vote results</p>
          <ul className="space-y-1">
            {pool.slice().sort((a, b) => (Number(scores[b.id]) || 0) - (Number(scores[a.id]) || 0)).map((item) => {
              const votes = Number(scores[item.id]) || 0;
              const pct = maxVotes > 0 ? (votes / maxVotes) * 100 : 0;
              const isWinner = item.name === result.winnerName;
              return (
                <li key={item.id} className={`rounded-lg px-3 py-2 ${isWinner ? 'bg-green-100 border border-green-200' : 'bg-white border border-gray-100'}`}>
                  <div className="flex justify-between items-center mb-1">
                    <span className={`text-sm font-medium ${isWinner ? 'text-green-800' : 'text-gray-700'}`}>
                      {isWinner && '🏆 '}{item.name}
                    </span>
                    <span className="text-xs text-gray-500">{votes} vote{votes !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-1.5">
                    <div className={`h-1.5 rounded-full ${isWinner ? 'bg-green-500' : 'bg-gray-300'}`} style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!scores && pool.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Pool</p>
          <div className="flex flex-wrap gap-1.5">
            {pool.map((item) => (
              <span key={item.id} className={`text-xs rounded-full px-2.5 py-0.5 border ${item.name === result.winnerName ? 'bg-green-100 border-green-300 text-green-800 font-semibold' : 'bg-white border-gray-200 text-gray-600'}`}>
                {item.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Share + calendar actions */}
      <div className="flex flex-col gap-2 pt-1 border-t border-green-200">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600 shrink-0">When?</label>
          <input
            type="datetime-local"
            value={localDate}
            onChange={(e) => setLocalDate(e.target.value)}
            className="flex-1 min-w-0 border border-gray-300 rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-400 bg-white"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {winner && (
            <button
              onClick={handleAddToOptions}
              disabled={isWinnerInOptions}
              className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isWinnerInOptions ? '✓ In Options' : '+ Add to Options'}
            </button>
          )}
          <button onClick={handleShare}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors">
            {shared ? '✓ Copied!' : '📤 Share result'}
          </button>
          <button onClick={handleGoogleCalendar}
            className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors">
            📅 Google Calendar
          </button>
          <button onClick={handleAppleCalendar} disabled={!localDate}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            📅 Apple Calendar
          </button>
        </div>
      </div>
    </div>
  );
}
