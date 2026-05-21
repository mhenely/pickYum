// Photo-forward coin used by HelpMeChoosePage (individual flow) and the
// GroupSessionPage CoinFlipOverlay. Owns the animation state internally —
// parents trigger flips imperatively via the ref handle and read results
// through callbacks. See CoinFlip.css for the visual treatment.

import { forwardRef, useImperativeHandle, useRef, useState, useEffect, useCallback } from 'react';
import { placePhotoUrl } from '../lib/api';
import './CoinFlip.css';

const SETTLE_MS = 550;
const ANTICIPATE_MS = 180;

const generateSparkles = (count = 10) =>
  Array.from({ length: count }).map((_, i) => {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
    const dist = 90 + Math.random() * 50;
    return {
      id: i,
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist - 6,
      delay: Math.random() * 80,
    };
  });

// `photoUrl` short-circuits the Google Places proxy — useful for the
// landing-page demo and any other caller that already has an absolute
// image URL. Falls back to the photos[] array (Places refs) when not
// supplied.
const restaurantPhotoUrl = (r) => {
  if (r?.photoUrl) return r.photoUrl;
  const first = r?.photos?.[0];
  if (!first) return null;
  return placePhotoUrl(first, 400);
};

// One face of the coin — restaurant photo full-bleed, name + side label
// overlaid at the bottom with a gradient fade. Gracefully falls back to
// the gradient name placeholder when no photo is available OR when the
// supplied URL fails to load (broken hot-link, CDN outage, etc).
const CoinFace = ({ restaurant, side, faceClass }) => {
  const photo = restaurantPhotoUrl(restaurant);
  const name = restaurant?.name ?? '—';
  const [imgFailed, setImgFailed] = useState(false);
  // Reset the error state when the restaurant changes — same coin face
  // may swap restaurants between flips (demo "Try different" button).
  useEffect(() => { setImgFailed(false); }, [photo]);
  return (
    <div className={`cf-face ${faceClass}`}>
      {photo && !imgFailed ? (
        <img
          src={photo}
          alt=""
          className="cf-photo"
          loading="eager"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div className="cf-photo-fallback">
          <span className="cf-photo-fallback-text">{name}</span>
        </div>
      )}
      <div className="cf-overlay">
        <span className="cf-name">{name}</span>
        <span className="cf-label">{side.toUpperCase()}</span>
      </div>
    </div>
  );
};

const CoinFlip = forwardRef(function CoinFlip(
  {
    headsRestaurant,
    tailsRestaurant,
    size = 240,
    onFlipStart,
    onResult,
    onComplete,
    showSparkles = true,
  },
  ref,
) {
  const [rotation, setRotation] = useState(0);
  const [transition, setTransition] = useState('none');
  const [phase, setPhase] = useState('idle'); // idle | anticipate | flipping | settle
  const [duration, setDuration] = useState(2400);
  const [result, setResult] = useState(null);
  const [sparkles, setSparkles] = useState([]);
  const flippingRef = useRef(false);

  const flip = useCallback((forcedResult) => {
    if (flippingRef.current) return;
    flippingRef.current = true;
    setResult(null);
    setSparkles([]);
    setPhase('anticipate');
    onFlipStart?.();

    setTimeout(() => {
      const seed =
        (Math.random() * 0.5 +
          (performance.now() % 1) * 0.3 +
          (Date.now() % 1000) * 0.0002) %
        1;
      const r = forcedResult ?? (seed > 0.5 ? 'heads' : 'tails');

      // Land the coin facing the correct side. The base "tails" face is
      // pre-rotated 180°, so target 180° to show it, 0° (mod 360) to show
      // heads. Always add an integer number of full rotations on top.
      setRotation((prev) => {
        const current = ((prev % 360) + 360) % 360;
        const target = r === 'tails' ? 180 : 0;
        let delta = (target - current + 360) % 360;
        if (delta === 0) delta = 360;
        const total = (Math.floor(Math.random() * 6) + 9) * 360 + delta;
        return prev + total;
      });

      const d = 2200 + Math.floor(Math.random() * 400);
      setDuration(d);
      setPhase('flipping');
      setTransition(`transform ${d}ms cubic-bezier(0.15, 0.65, 0.28, 1)`);

      setTimeout(() => {
        setResult(r);
        setTransition('none');
        setPhase('settle');
        if (showSparkles) setSparkles(generateSparkles());
        onResult?.(r);

        setTimeout(() => {
          setPhase('idle');
          flippingRef.current = false;
          onComplete?.();
        }, SETTLE_MS);
      }, d + 50);
    }, ANTICIPATE_MS);
  }, [onFlipStart, onResult, onComplete, showSparkles]);

  const reset = useCallback(() => {
    setResult(null);
    setSparkles([]);
  }, []);

  useImperativeHandle(ref, () => ({ flip, reset }), [flip, reset]);

  const shellClass = phase !== 'idle' ? phase : '';
  const tossClass = phase === 'flipping' ? 'flipping' : '';

  return (
    <div className="cf-perspective" style={{ width: size, height: size }}>
      {result && showSparkles && (
        <>
          <div key={`glow-${result}-${rotation}`} className="cf-glow" />
          {sparkles.map((s) => (
            <div
              key={s.id}
              className="cf-sparkle"
              style={{
                '--cf-sparkle-dx': `${s.dx}px`,
                '--cf-sparkle-dy': `${s.dy}px`,
                '--cf-sparkle-delay': `${s.delay}ms`,
              }}
            />
          ))}
        </>
      )}
      <div className={`cf-shell ${shellClass}`}>
        <div
          className={`cf-toss ${tossClass}`}
          style={{ '--cf-flip-duration': `${duration}ms` }}
        >
          <div
            className="cf-coin"
            style={{ transform: `rotateY(${rotation}deg)`, transition }}
          >
            <CoinFace restaurant={headsRestaurant} side="heads" faceClass="cf-heads" />
            <CoinFace restaurant={tailsRestaurant} side="tails" faceClass="cf-tails" />
          </div>
        </div>
      </div>
    </div>
  );
});

export default CoinFlip;
