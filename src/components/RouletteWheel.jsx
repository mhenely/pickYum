// Photo-wedges roulette wheel. Each sector is the restaurant's photo
// clipped to the wedge shape, with the name running radially along the
// spoke so long names use the wedge's radial length (~0.7R) instead of
// the cramped tangential chord. Left-half wedges flip 180° so letters
// stay upright (Wheel-of-Fortune convention).
//
// Used by:
//   - HelpMeChoosePage (individual flow) — random spin via spin()
//   - GroupSessionPage RouletteOverlay   — predetermined-winner spin via
//                                          spinTo(winnerId, candidates)
//
// Photos load lazily inside the wheel — the parent only needs to pass
// the restaurants map (each entry's `photos[0]` is read for the face).
// Fallback palette covers entries without a photo.

import { useRef, useEffect, useImperativeHandle, forwardRef, memo, useState } from 'react';
import { placePhotoUrl } from '../lib/api';

// ── Constants ─────────────────────────────────────────────────

// Fallback palette for entries that don't have a photo — chosen so
// neighboring wedges remain visually distinct without competing with
// the brand orange (which lives on the pointer / pulse).
const FALLBACK_COLORS = [
  '#475569', '#334155', '#1e293b', '#3f3f46', '#52525b',
  '#3f4347', '#2c3035', '#404954', '#404449', '#33373c',
];

const W   = 360;
const H   = 376;
const CX  = W / 2;
const CY  = W / 2 + 16;
const R   = W / 2 - 28;
const RIM = 14;

// ── Helpers ───────────────────────────────────────────────────

function lighten(hex, factor) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.round(r + (255 - r) * factor)},${Math.round(g + (255 - g) * factor)},${Math.round(b + (255 - b) * factor)})`;
}

// Returns the index of the sector currently under the pointer (top of
// wheel). The pointer sits at canvas angle -π/2 (straight up from CX/CY).
function highlightedAt(angle, n) {
  if (n === 0) return -1;
  const s = (2 * Math.PI) / n;
  const norm = (((-angle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.floor(norm / s) % n;
}

// Truncates `str` with an ellipsis until ctx.measureText says it fits
// within `maxPx`. Caller must set ctx.font first. Pixel-measured rather
// than a hard-coded character cap so long names (e.g. "Fire on the
// Mountain Buffalo Wings | Burnside") truncate cleanly.
function fitToWidth(ctx, str, maxPx) {
  if (ctx.measureText(str).width <= maxPx) return str;
  let lo = 1;
  let hi = str.length;
  while (lo < hi) {
    const m = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(str.slice(0, m) + '…').width <= maxPx) lo = m;
    else hi = m - 1;
  }
  return str.slice(0, lo) + '…';
}

// ── Painter ───────────────────────────────────────────────────

function paint(ctx, angle, options, restaurants, images, pointerWiggle = 0, pulseSector = -1, pulseAlpha = 0) {
  const n = options.length;
  ctx.clearRect(0, 0, W, H);

  // Drop shadow under the wheel
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.arc(CX, CY, R + RIM, 0, 2 * Math.PI);
  ctx.fillStyle = '#1a1a1a';
  ctx.fill();
  ctx.restore();

  // Thin metallic rim
  ctx.beginPath();
  ctx.arc(CX, CY, R + RIM, 0, 2 * Math.PI);
  const rim = ctx.createLinearGradient(CX - R, CY - R, CX + R, CY + R);
  rim.addColorStop(0,    '#5a5a5a');
  rim.addColorStop(0.5,  '#cccccc');
  rim.addColorStop(1,    '#3a3a3a');
  ctx.fillStyle = rim;
  ctx.fill();

  // Inner dark separator between rim and wedges
  ctx.beginPath();
  ctx.arc(CX, CY, R + 1, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (n === 0) {
    // Empty-state interior
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, 2 * Math.PI);
    ctx.fillStyle = '#1f2937';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Add options to spin', CX, CY);
  } else {
    const s = (2 * Math.PI) / n;
    const hi = highlightedAt(angle, n);

    // ── Wedges (photo-filled, clipped to wedge shape) ──
    for (let i = 0; i < n; i++) {
      const a0   = angle + i * s - Math.PI / 2;
      const a1   = a0 + s;
      const mid  = a0 + s / 2;
      const isHi = i === hi;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, a0, a1);
      ctx.closePath();
      ctx.clip();

      const img = images[options[i]];
      if (img && img.complete && img.naturalWidth > 0) {
        // Photo positioned at the wedge midpoint, oriented along the
        // spoke so the photo rotates with the wedge when the wheel spins.
        // photoSize 1.1R + midR 0.55R means the photo extends from the
        // center to slightly past the rim — clipping leaves only the
        // wedge-shaped portion visible.
        const midR = R * 0.55;
        const px = CX + midR * Math.cos(mid);
        const py = CY + midR * Math.sin(mid);
        const photoSize = R * 1.1;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(mid + Math.PI / 2);
        ctx.drawImage(img, -photoSize / 2, -photoSize / 2, photoSize, photoSize);
        ctx.restore();
      } else {
        // No photo (or not yet loaded) — fall back to a dark slate fill
        // so the wedge still reads as distinct. Highlighted wedge brightens.
        const c = FALLBACK_COLORS[i % FALLBACK_COLORS.length];
        ctx.fillStyle = isHi ? lighten(c, 0.25) : c;
        ctx.fillRect(0, 0, W, H);
      }

      // Slight wash on non-highlighted wedges so the wedge under the
      // pointer pops.
      if (!isHi) {
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(0, 0, W, H);
      }

      ctx.restore();

      // Crisp white divider along the leading wedge edge
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(CX + R * Math.cos(a0), CY + R * Math.sin(a0));
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ── Winner pulse overlay ──
    if (pulseSector >= 0 && pulseSector < n && pulseAlpha > 0) {
      const a0 = angle + pulseSector * s - Math.PI / 2;
      const a1 = a0 + s;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = `rgba(255, 245, 200, ${pulseAlpha})`;
      ctx.fill();
      ctx.restore();
    }

    // ── Vignette — darker at rim for depth ──
    const vignette = ctx.createRadialGradient(CX, CY, R * 0.5, CX, CY, R);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, 2 * Math.PI);
    ctx.fillStyle = vignette;
    ctx.fill();

    // ── Labels — radial orientation with left-half flip ──
    // Text gets the wedge's full radial length (~0.66R) instead of the
    // narrow chord, so long restaurant names no longer overflow into
    // neighbors. Truncation is pixel-measured so it adapts to font /
    // wheel-size changes without manual char caps.
    const fontSize = n > 12 ? 12 : n > 8 ? 13 : 14;
    const innerR = R * 0.22;
    const outerR = R * 0.88;
    const labelMid = (innerR + outerR) / 2;
    const radialBudget = (outerR - innerR) - 8;

    for (let i = 0; i < n; i++) {
      const a0  = angle + i * s - Math.PI / 2;
      const mid = a0 + s / 2;
      const normMid = ((mid % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      // Wedges whose midline points into the canvas's left half would
      // render text upside-down under a pure radial transform — flip
      // those 180° so the letters always read naturally.
      const isLeftHalf = normMid > Math.PI / 2 && normMid < 3 * Math.PI / 2;

      ctx.save();
      ctx.translate(CX, CY);
      ctx.rotate(mid);             // local +x → radial outward
      ctx.translate(labelMid, 0);   // sit at the wedge's radial midpoint
      if (isLeftHalf) ctx.rotate(Math.PI);

      ctx.font = `bold ${fontSize}px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const fullName = restaurants[options[i]]?.name ?? '?';
      const labelText = fitToWidth(ctx, fullName, radialBudget);

      // Stacked dark shadows in place of the old solid dark band — the
      // band was what visually bled past the wedge at its narrow inner
      // end. Shadows hug each glyph so they always stay inside the wedge.
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1]]) {
        ctx.fillText(labelText, dx, dy);
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillText(labelText, 0, 0);

      ctx.restore();
    }
  }

  // ── Center boss — small chrome dome ──
  const hubR = 22;
  ctx.beginPath();
  ctx.arc(CX, CY, hubR + 3, 0, 2 * Math.PI);
  ctx.fillStyle = '#0a0a0a';
  ctx.fill();
  const boss = ctx.createRadialGradient(CX - hubR / 2, CY - hubR / 2, 1, CX, CY, hubR);
  boss.addColorStop(0,    '#eaeaea');
  boss.addColorStop(0.4,  '#aaaaaa');
  boss.addColorStop(1,    '#2a2a2a');
  ctx.beginPath();
  ctx.arc(CX, CY, hubR, 0, 2 * Math.PI);
  ctx.fillStyle = boss;
  ctx.fill();
  // Specular highlight
  ctx.beginPath();
  ctx.ellipse(CX - 5, CY - 6, 7, 4, -Math.PI / 4, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fill();

  // ── Pointer ──
  drawSlimPointer(ctx, pointerWiggle);
}

// Slim teardrop in PickYum brand orange. Pivot at the rim-mount point so
// the body wiggles each time a sector edge passes under the tip; the
// mount itself stays anchored.
function drawSlimPointer(ctx, wiggle) {
  const tipY = CY - R - 2;
  ctx.save();
  if (wiggle !== 0) {
    ctx.translate(CX, tipY - 12);
    ctx.rotate(wiggle);
    ctx.translate(-CX, -(tipY - 12));
  }

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;

  ctx.beginPath();
  ctx.moveTo(CX, tipY);
  ctx.lineTo(CX - 8, tipY - 18);
  ctx.quadraticCurveTo(CX - 8, tipY - 26, CX, tipY - 26);
  ctx.quadraticCurveTo(CX + 8, tipY - 26, CX + 8, tipY - 18);
  ctx.closePath();
  ctx.fillStyle = '#f97316';
  ctx.fill();

  // Inner highlight
  ctx.beginPath();
  ctx.moveTo(CX - 2, tipY - 4);
  ctx.lineTo(CX - 6, tipY - 18);
  ctx.quadraticCurveTo(CX - 6, tipY - 24, CX - 1, tipY - 24);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

// ── Pointer wiggle ────────────────────────────────────────────

const WIGGLE_DUR  = 90;   // ms
const WIGGLE_PEAK = 0.07; // ~4° at peak

function computeWiggle(now, wiggleStart) {
  const age = now - wiggleStart;
  if (age < 0 || age >= WIGGLE_DUR) return 0;
  return Math.sin((age / WIGGLE_DUR) * Math.PI) * WIGGLE_PEAK;
}

// ── Component ─────────────────────────────────────────────────

const RouletteWheel = forwardRef(function RouletteWheel(
  { options, restaurants, onSpinComplete },
  ref,
) {
  const canvasRef   = useRef(null);
  const angleRef    = useRef(0);
  const rafRef      = useRef(null);
  const lastHiRef   = useRef(-1);
  const wiggleAtRef = useRef(-Infinity);

  // Photo cache — keyed by restaurant id. Mutated directly so paint
  // calls always see the freshest map; `imagesVersion` triggers static
  // repaints once a load resolves while no spin is in flight.
  const imagesRef = useRef({});
  const [imagesVersion, setImagesVersion] = useState(0);

  // Always-current props snapshot so the animation loop never reads stale data
  const live = useRef({ options, restaurants, onSpinComplete });
  live.current = { options, restaurants, onSpinComplete };

  // Lazy-load any photos for the current options that haven't loaded yet.
  // Browser cache deduplicates real fetches when the same restaurant
  // appears in multiple wheel instances (e.g. RouletteOverlay + the
  // Choose page's wheel in two tabs).
  useEffect(() => {
    options.forEach((id) => {
      if (imagesRef.current[id]) return;
      const first = restaurants[id]?.photos?.[0];
      if (!first) return;
      const url = placePhotoUrl(first, 400);
      if (!url) return;
      const img = new Image();
      img.onload = () => {
        imagesRef.current[id] = img;
        setImagesVersion((v) => v + 1);
      };
      img.onerror = () => { /* falls back to color placeholder */ };
      img.src = url;
    });
  }, [options, restaurants]);

  // Repaint on prop / image-load changes while no spin is in flight.
  // The RAF guard prevents this static paint from racing the spin loop's
  // per-frame writes — without it, a parent re-render mid-spin would
  // paint a frozen frame on top of the running animation and flicker.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    if (rafRef.current) return;
    paint(ctx, angleRef.current, options, restaurants, imagesRef.current);
  }, [options, restaurants, imagesVersion]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // Winner pulse — 3 white-overlay pulses on the winning sector.
  const runWinnerPulse = (angle, pool, rests, winnerIdx, onDone) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) { onDone(); return; }
    const DUR = 1500;
    const PULSE_COUNT = 3;
    const t0 = performance.now();
    const step = (now) => {
      const t = (now - t0) / DUR;
      if (t >= 1) {
        paint(ctx, angle, pool, rests, imagesRef.current);
        onDone();
        return;
      }
      const alpha = Math.abs(Math.sin(t * Math.PI * PULSE_COUNT)) * 0.55;
      paint(ctx, angle, pool, rests, imagesRef.current, 0, winnerIdx, alpha);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  // Shared spin runner used by both spin() (random) and spinTo(id)
  // (predetermined). Returns the chosen index for the parent's onSpinComplete.
  const runSpin = (pool, rests, winnerIdx, onDone) => {
    const n = pool.length;
    if (n < 2) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const s = (2 * Math.PI) / n;
    const halfSector = s / 2;
    const targetNorm = (2 * Math.PI - (winnerIdx + 0.5) * s + 2 * Math.PI) % (2 * Math.PI);
    const currentNorm = ((angleRef.current % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let delta = targetNorm - currentNorm;
    if (delta <= 0) delta += 2 * Math.PI;

    const fullSpins      = 8 + Math.floor(Math.random() * 5);
    const totalDelta     = fullSpins * 2 * Math.PI + delta;
    const overshootDelta = totalDelta + halfSector * 0.85;
    const startAngle = angleRef.current;
    const endAngle   = startAngle + totalDelta;
    const duration   = 6000 + Math.random() * 1500;
    const phase1End  = duration * 0.85;
    const t0 = performance.now();

    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    lastHiRef.current   = highlightedAt(startAngle, n);
    wiggleAtRef.current = -Infinity;

    const step = (now) => {
      const elapsed = now - t0;
      let angle;
      if (elapsed < phase1End) {
        // Ease-out cubic to overshoot
        const t = elapsed / phase1End;
        const eased = 1 - Math.pow(1 - t, 3);
        angle = startAngle + overshootDelta * eased;
      } else if (elapsed < duration) {
        // Ease back from overshoot to target
        const t = (elapsed - phase1End) / (duration - phase1End);
        const eased = 1 - Math.pow(1 - t, 2);
        angle = startAngle + overshootDelta + (totalDelta - overshootDelta) * eased;
      } else {
        angle = endAngle;
      }
      angleRef.current = angle;

      const newHi = highlightedAt(angle, n);
      if (newHi !== lastHiRef.current) {
        wiggleAtRef.current = now;
        lastHiRef.current = newHi;
      }
      paint(ctx, angle, pool, rests, imagesRef.current,
            computeWiggle(now, wiggleAtRef.current));

      if (elapsed < duration) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        angleRef.current = endAngle;
        runWinnerPulse(endAngle, pool, rests, winnerIdx, () => onDone(pool[winnerIdx]));
      }
    };

    rafRef.current = requestAnimationFrame(step);
  };

  useImperativeHandle(ref, () => ({
    // Random winner — individual flow.
    spin() {
      const { options: sels, restaurants: rests, onSpinComplete: onCb } = live.current;
      const n = sels.length;
      if (n < 2) return;
      const entropy = (Math.random() * 0.6 + (performance.now() % 1) * 0.25 + (Date.now() % 100) * 0.004) % 1;
      const winnerIdx = Math.floor(entropy * n);
      runSpin(sels, rests, winnerIdx, (winnerId) => onCb?.(winnerId));
    },

    // Predetermined winner — group session flow. Caller passes the ordered
    // candidates array so we land on the right sector regardless of which
    // wheel-instance pool order the server used.
    spinTo(winnerId, candidates) {
      const { restaurants: rests, onSpinComplete: onCb, options: sels } = live.current;
      const pool = candidates ?? sels;
      const winnerIdx = pool.findIndex((id) => String(id) === String(winnerId));
      if (winnerIdx < 0) return;
      runSpin(pool, rests, winnerIdx, (id) => onCb?.(id));
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      width={W}
      height={H}
      className="max-w-full drop-shadow-xl"
    />
  );
});

// memo because the wheel drives the spin imperatively via refs — the only
// time it should re-render is when options actually change. Parent
// re-renders (e.g. timer ticks, hover state) would otherwise trigger this
// component's render → effect → paint cycle for nothing.
export default memo(RouletteWheel);
