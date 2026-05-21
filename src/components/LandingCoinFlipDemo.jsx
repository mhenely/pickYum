// Sandbox version of the in-app coin flip — embedded on LandingPage so
// first-time visitors get a tactile feel for the core "we pick for you"
// moment before signing up. Uses the real CoinFlip component (no fork)
// with two pre-populated sample restaurants that have no photos, so the
// component's built-in gradient fallback renders.
//
// Self-contained: owns its own ref + result state, no redux. The CTAs
// don't navigate anywhere — they just flip, swap, and reset locally.

import { useRef, useState } from 'react';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import CoinFlip from './CoinFlip';

// Three sample restaurants so the user can flip a few times and see
// different match-ups. The coin only takes two at a time; we rotate
// which two are shown on each reset so it doesn't feel canned.
//
// photoUrl uses Unsplash's CDN (free + stable for hot-linking; sized via
// query params). CoinFlip's onError handler falls back to the dark
// gradient name-placeholder if any URL fails to load, so a broken
// hot-link degrades gracefully rather than rendering "missing image."
//
// Crop parameters: ?w=400&q=80&fit=crop&crop=center keeps the file small
// and centers the food in the square coin face.
const PHOTO_PARAMS = '?w=400&q=80&fit=crop&crop=center';
const SAMPLES = [
  {
    id: 'demo-1',
    name: 'Tasty Slice',
    type: 'Italian',
    photoUrl: `https://images.unsplash.com/photo-1513104890138-7c749659a591${PHOTO_PARAMS}`,
  },
  {
    id: 'demo-2',
    name: 'Sakura Ramen',
    type: 'Japanese',
    photoUrl: `https://images.unsplash.com/photo-1557872943-16a5ac26437e${PHOTO_PARAMS}`,
  },
  {
    id: 'demo-3',
    name: 'Burger Junction',
    type: 'American',
    photoUrl: `https://images.unsplash.com/photo-1568901346375-23c9450c58cd${PHOTO_PARAMS}`,
  },
];

// Pick 2 random distinct samples (Fisher-Yates-lite). Used on mount
// and on "Try different restaurants" so the demo varies each round.
function pickPair() {
  const a = SAMPLES[Math.floor(Math.random() * SAMPLES.length)];
  let b = SAMPLES[Math.floor(Math.random() * SAMPLES.length)];
  while (b.id === a.id) b = SAMPLES[Math.floor(Math.random() * SAMPLES.length)];
  return { heads: a, tails: b };
}

export default function LandingCoinFlipDemo() {
  const flipRef = useRef(null);
  const [pair, setPair]     = useState(() => pickPair());
  const [result, setResult] = useState(null);
  const [busy, setBusy]     = useState(false);

  const handleFlip = () => {
    setResult(null);
    setBusy(true);
    flipRef.current?.flip();
  };

  const handleReset = () => {
    flipRef.current?.reset();
    setResult(null);
    setPair(pickPair());
  };

  const winner = result === 'heads' ? pair.heads : result === 'tails' ? pair.tails : null;

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Tag above the coin makes it obvious this is interactive,
          not decorative. The "no signup" line directly addresses the
          friction-anxiety a first-time visitor brings to the page. */}
      <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 backdrop-blur-sm px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
        Try it — no signup
      </span>

      <CoinFlip
        ref={flipRef}
        headsRestaurant={pair.heads}
        tailsRestaurant={pair.tails}
        size={220}
        onResult={(r) => { setResult(r); }}
        onComplete={() => setBusy(false)}
      />

      {/* Result panel — fades in once a flip lands. Slot stays the
          same height regardless of state so the layout doesn't jump
          between idle / busy / settled. */}
      <div className="min-h-[68px] w-full max-w-xs text-center">
        {winner ? (
          <div className="animate-[fadeIn_300ms_ease-out]">
            <p className="text-[11px] uppercase tracking-wider text-orange-50/80">It picked</p>
            <p className="text-xl font-bold text-white">{winner.name}</p>
            <p className="text-xs text-orange-50/80">{winner.type}</p>
          </div>
        ) : (
          <p className="text-sm text-orange-50/90 pt-3">
            <span className="font-semibold">{pair.heads.name}</span>
            <span className="opacity-60"> or </span>
            <span className="font-semibold">{pair.tails.name}</span>?
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleFlip}
          disabled={busy}
          className="rounded-lg bg-white text-orange-600 px-5 py-2 text-sm font-bold shadow-md hover:bg-orange-50 disabled:opacity-60 transition-colors"
        >
          {busy ? 'Flipping…' : winner ? 'Flip again' : 'Flip the coin'}
        </button>
        {winner && (
          <button
            type="button"
            onClick={handleReset}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg border border-white/40 text-white px-3 py-2 text-xs font-semibold hover:bg-white/10 disabled:opacity-60 transition-colors"
          >
            <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Try different
          </button>
        )}
      </div>
    </div>
  );
}
