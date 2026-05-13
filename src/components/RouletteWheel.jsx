import { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';

// ── Constants ─────────────────────────────────────────────────

// Rich jewel-tone palette — deep, saturated, clearly distinct
const COLORS = [
  '#C62828', '#1565C0', '#2E7D32', '#6A1B9A', '#E65100',
  '#00695C', '#AD1457', '#0277BD', '#33691E', '#4527A0',
  '#B71C1C', '#01579B', '#1B5E20', '#4A148C', '#BF360C',
  '#006064', '#880E4F', '#0D47A1', '#558B2F', '#D81B60',
];

const W   = 360;         // canvas width
const H   = 376;         // canvas height — extra room so the rim's drop-shadow ring isn't clipped
const CX  = W / 2;       // wheel center x
const CY  = W / 2 + 16;  // wheel center y — shifted down to leave room for pointer
const R   = W / 2 - 28;  // wheel radius (inner edge of rim)
const RIM = 14;          // rim band width

// ── Helpers ───────────────────────────────────────────────────

/** Lightens a hex color by `factor` (0–1). */
function lighten(hex, factor) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.round(r + (255 - r) * factor)},${Math.round(g + (255 - g) * factor)},${Math.round(b + (255 - b) * factor)})`;
}

/**
 * Returns the index of the sector currently under the pointer (top of wheel).
 * The pointer sits at canvas angle -π/2 (straight up from center).
 * As the wheel rotates by `angle`, the pointer's position relative to the
 * wheel is −angle, so we find which sector contains that angle.
 */
function highlightedAt(angle, n) {
  if (n === 0) return -1;
  const s = (2 * Math.PI) / n;
  const norm = (((-angle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.floor(norm / s) % n;
}

/** Truncates a string with an ellipsis if it exceeds `max` characters. */
function trunc(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ── Pure canvas painter ───────────────────────────────────────

function goldGradient(ctx, cx, cy, r) {
  const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  g.addColorStop(0,    '#a07828');
  g.addColorStop(0.25, '#e8c84a');
  g.addColorStop(0.5,  '#f5dd6e');
  g.addColorStop(0.75, '#d4a830');
  g.addColorStop(1,    '#8c6418');
  return g;
}

function drawPointer(ctx, wiggle = 0) {
  const tipY    = CY - R - 2;
  const pinH    = 34;
  const pinW    = 9;
  const baseY   = tipY - pinH;
  const baseCapY = baseY + 10;

  // Wiggle: pivot at the rim mount point — pin body swings, tip stays anchored
  ctx.save();
  if (wiggle !== 0) {
    ctx.translate(CX, tipY);
    ctx.rotate(wiggle);
    ctx.translate(-CX, -tipY);
  }

  ctx.save();
  ctx.shadowColor   = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur    = 8;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 3;

  // Pin shape: rounded top, tapered to a point
  ctx.beginPath();
  ctx.moveTo(CX, tipY);
  ctx.lineTo(CX - pinW, baseCapY);
  ctx.quadraticCurveTo(CX - pinW, baseY, CX, baseY);
  ctx.quadraticCurveTo(CX + pinW, baseY, CX + pinW, baseCapY);
  ctx.closePath();

  const pinGrad = ctx.createLinearGradient(CX - pinW, 0, CX + pinW, 0);
  pinGrad.addColorStop(0,    '#b91c1c');
  pinGrad.addColorStop(0.35, '#ef4444');
  pinGrad.addColorStop(0.6,  '#dc2626');
  pinGrad.addColorStop(1,    '#7f1d1d');
  ctx.fillStyle = pinGrad;
  ctx.fill();

  // Specular sheen on pin
  ctx.beginPath();
  ctx.moveTo(CX - 2, tipY - 4);
  ctx.lineTo(CX - pinW + 2, baseCapY);
  ctx.quadraticCurveTo(CX - pinW + 2, baseY + 2, CX - 1, baseY + 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.fill();
  ctx.restore();
  ctx.restore();

  // Mounting base — drawn outside the wiggle transform so it stays anchored
  ctx.beginPath();
  ctx.arc(CX, tipY + 2, 5, 0, 2 * Math.PI);
  ctx.fillStyle = goldGradient(ctx, CX, tipY + 2, 5);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function paint(ctx, angle, selections, restaurants, pointerWiggle = 0, pulseSector = -1, pulseAlpha = 0) {
  const n = selections.length;
  ctx.clearRect(0, 0, W, H);

  // ── Outer drop-shadow ring ──────────────────────────────────
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur  = 18;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.arc(CX, CY, R + RIM + 2, 0, 2 * Math.PI);
  ctx.fillStyle = '#111';
  ctx.fill();
  ctx.restore();

  // ── Gold metallic rim ───────────────────────────────────────
  ctx.beginPath();
  ctx.arc(CX, CY, R + RIM, 0, 2 * Math.PI);
  ctx.fillStyle = goldGradient(ctx, CX, CY, R + RIM);
  ctx.fill();

  // Thin dark inner edge of rim
  ctx.beginPath();
  ctx.arc(CX, CY, R + 1, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (n === 0) {
    // Empty-state wheel
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, 2 * Math.PI);
    ctx.fillStyle = '#1f2937';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Add selections to spin', CX, CY);
  } else {
    const s        = (2 * Math.PI) / n;
    const hi       = highlightedAt(angle, n);
    const fontSize = n > 12 ? 8 : n > 8 ? 10 : 11;
    const maxChars = n > 12 ? 8 : n > 8 ? 10 : 13;

    // ── Sectors ─────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const a0    = angle + i * s - Math.PI / 2;
      const a1    = a0 + s;
      const color = COLORS[i % COLORS.length];
      const isHi  = i === hi;

      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = isHi ? lighten(color, 0.38) : color;
      ctx.fill();

      // Crisp divider lines
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth   = 1;
      ctx.stroke();
    }

    // ── Winner pulse overlay (F) ─────────────────────────────
    if (pulseSector >= 0 && pulseSector < n && pulseAlpha > 0) {
      const a0 = angle + pulseSector * s - Math.PI / 2;
      const a1 = a0 + s;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = `rgba(255, 245, 200, ${pulseAlpha})`;
      ctx.fill();
    }

    // ── Radial vignette — gives the wheel a slight dome effect ─
    const vignette = ctx.createRadialGradient(CX, CY - R * 0.28, 0, CX, CY, R);
    vignette.addColorStop(0,   'rgba(255,255,255,0.13)');
    vignette.addColorStop(0.5, 'rgba(255,255,255,0.0)');
    vignette.addColorStop(1,   'rgba(0,0,0,0.28)');
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, 2 * Math.PI);
    ctx.fillStyle = vignette;
    ctx.fill();

    // ── Labels ──────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const a0  = angle + i * s - Math.PI / 2;
      const mid = a0 + s / 2;
      const tr  = R * 0.63;
      ctx.save();
      ctx.translate(CX + tr * Math.cos(mid), CY + tr * Math.sin(mid));
      ctx.rotate(mid + Math.PI / 2);
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.font         = `bold ${fontSize}px 'Segoe UI', system-ui, sans-serif`;
      // Drop shadow
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(trunc(restaurants[selections[i]]?.name ?? '?', maxChars), 1, 1);
      // Label
      ctx.fillStyle = 'rgba(255,255,255,0.97)';
      ctx.fillText(trunc(restaurants[selections[i]]?.name ?? '?', maxChars), 0, 0);
      ctx.restore();
    }

    // ── Rim tick marks at sector boundaries ─────────────────
    for (let i = 0; i < n; i++) {
      const a = angle + i * s - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(CX + (R + 2)  * Math.cos(a), CY + (R + 2)  * Math.sin(a));
      ctx.lineTo(CX + (R + RIM - 2) * Math.cos(a), CY + (R + RIM - 2) * Math.sin(a));
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }
  }

  // ── Center hub ───────────────────────────────────────────────
  const hubR = 28;

  // Gold outer ring
  ctx.beginPath();
  ctx.arc(CX, CY, hubR + 7, 0, 2 * Math.PI);
  ctx.fillStyle = goldGradient(ctx, CX, CY, hubR + 7);
  ctx.fill();

  // Dark separator
  ctx.beginPath();
  ctx.arc(CX, CY, hubR + 1, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Polished steel inner disc
  const steel = ctx.createRadialGradient(CX - 9, CY - 9, 1, CX, CY, hubR);
  steel.addColorStop(0,    '#e8e8e8');
  steel.addColorStop(0.35, '#b0b0b0');
  steel.addColorStop(0.7,  '#4a4a4a');
  steel.addColorStop(1,    '#1a1a1a');
  ctx.beginPath();
  ctx.arc(CX, CY, hubR, 0, 2 * Math.PI);
  ctx.fillStyle = steel;
  ctx.fill();

  // Specular highlight
  ctx.beginPath();
  ctx.ellipse(CX - 7, CY - 8, 9, 6, -Math.PI / 4, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fill();

  // Center pin
  ctx.beginPath();
  ctx.arc(CX, CY, 5, 0, 2 * Math.PI);
  ctx.fillStyle = goldGradient(ctx, CX, CY, 5);
  ctx.fill();

  // ── Pointer ──────────────────────────────────────────────────
  drawPointer(ctx, pointerWiggle);
}

// ── Tick (pointer wiggle) constants ───────────────────────────
const WIGGLE_DUR  = 90;     // ms
const WIGGLE_PEAK = 0.07;   // ~4° at peak

function computeWiggle(now, wiggleStart) {
  const age = now - wiggleStart;
  if (age < 0 || age >= WIGGLE_DUR) return 0;
  return Math.sin((age / WIGGLE_DUR) * Math.PI) * WIGGLE_PEAK;
}

// ── Component ─────────────────────────────────────────────────

const RouletteWheel = forwardRef(function RouletteWheel(
  { selections, restaurants, onSpinComplete },
  ref
) {
  const canvasRef = useRef(null);
  const angleRef  = useRef(0);
  const rafRef    = useRef(null);
  const lastHiRef     = useRef(-1);
  const wiggleAtRef   = useRef(-Infinity);

  // Always-current props snapshot so the animation loop never reads stale data
  const live = useRef({ selections, restaurants, onSpinComplete });
  live.current = { selections, restaurants, onSpinComplete };

  // Redraw when selections change (outside of an active spin)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    paint(canvas.getContext('2d'), angleRef.current, selections, restaurants);
  }, [selections]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cancel any running animation on unmount
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // ── Winner pulse (F): 3 white-overlay pulses on the winning sector ─
  const runWinnerPulse = (angle, pool, rests, winnerIdx, onComplete) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) { onComplete(); return; }
    const PULSE_DUR   = 1500;
    const PULSE_COUNT = 3;
    const t0 = performance.now();
    const step = (now) => {
      const t = (now - t0) / PULSE_DUR;
      if (t >= 1) {
        paint(ctx, angle, pool, rests);
        onComplete();
        return;
      }
      const alpha = Math.abs(Math.sin(t * Math.PI * PULSE_COUNT)) * 0.55;
      paint(ctx, angle, pool, rests, 0, winnerIdx, alpha);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  useImperativeHandle(ref, () => ({
    // Spins to a specific index — used by group session mode where the winner
    // is predetermined server-side. Accepts the winning restaurant ID and the
    // ordered candidates array so it can locate the right sector.
    spinTo(winnerId, candidates) {
      const { selections: sels, restaurants: rests, onSpinComplete: onDone } = live.current;
      const pool = candidates ?? sels;
      const n = pool.length;
      if (n < 2) return;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);

      const winnerIdx = pool.findIndex((id) => String(id) === String(winnerId));
      if (winnerIdx < 0) return;

      const s = (2 * Math.PI) / n;
      const halfSector = s / 2;
      const targetNorm = (2 * Math.PI - (winnerIdx + 0.5) * s + 2 * Math.PI) % (2 * Math.PI);
      const currentNorm = ((angleRef.current % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let delta = targetNorm - currentNorm;
      if (delta <= 0) delta += 2 * Math.PI;

      const fullSpins      = 8 + Math.floor(Math.random() * 5);
      const totalDelta     = fullSpins * 2 * Math.PI + delta;
      const overshootDelta = totalDelta + halfSector * 0.85; // overshoot ~half a sector
      const startAngle = angleRef.current;
      const endAngle   = startAngle + totalDelta;
      const duration   = 6000 + Math.random() * 1500;
      const phase1End  = duration * 0.85;
      const t0 = performance.now();

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!ctx) return;

      lastHiRef.current   = highlightedAt(startAngle, n);
      wiggleAtRef.current = -Infinity;

      const step = (now) => {
        const elapsed = now - t0;
        let angle;
        if (elapsed < phase1End) {
          // Phase 1: ease-out cubic to overshoot
          const t = elapsed / phase1End;
          const eased = 1 - Math.pow(1 - t, 3);
          angle = startAngle + overshootDelta * eased;
        } else if (elapsed < duration) {
          // Phase 2: ease-out from overshoot back to target
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
          lastHiRef.current   = newHi;
        }
        paint(ctx, angle, pool, rests, computeWiggle(now, wiggleAtRef.current));

        if (elapsed < duration) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          angleRef.current = endAngle;
          runWinnerPulse(endAngle, pool, rests, winnerIdx, () => onDone?.(pool[winnerIdx]));
        }
      };
      rafRef.current = requestAnimationFrame(step);
    },

    spin() {
      const { selections: sels, restaurants: rests, onSpinComplete: onDone } = live.current;
      const n = sels.length;
      if (n < 2) return;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);

      // High-entropy winner selection
      const entropy = (Math.random() * 0.6 + (performance.now() % 1) * 0.25 + (Date.now() % 100) * 0.004) % 1;
      const winnerIdx = Math.floor(entropy * n);

      // Calculate the exact rotation needed to center the winning sector under the pointer.
      // Under the pointer (top): normalized wheel angle = 2π − (winnerIdx + 0.5) × sectorAngle
      const s = (2 * Math.PI) / n;
      const halfSector = s / 2;
      const targetNorm = (2 * Math.PI - (winnerIdx + 0.5) * s + 2 * Math.PI) % (2 * Math.PI);
      const currentNorm = ((angleRef.current % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let delta = targetNorm - currentNorm;
      if (delta <= 0) delta += 2 * Math.PI;

      // Add random full rotations so the landing position is never predictable by feel
      const fullSpins      = 8 + Math.floor(Math.random() * 5); // 8–12 extra full rotations
      const totalDelta     = fullSpins * 2 * Math.PI + delta;
      const overshootDelta = totalDelta + halfSector * 0.85;    // overshoot ~half a sector
      const startAngle = angleRef.current;
      const endAngle   = startAngle + totalDelta;

      // 6–7.5 s total; phase 1 (85%) eases out to overshoot, phase 2 (15%) corrects back
      const duration  = 6000 + Math.random() * 1500;
      const phase1End = duration * 0.85;
      const t0 = performance.now();

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!ctx) return;

      lastHiRef.current   = highlightedAt(startAngle, n);
      wiggleAtRef.current = -Infinity;

      const step = (now) => {
        const elapsed = now - t0;
        let angle;
        if (elapsed < phase1End) {
          const t = elapsed / phase1End;
          const eased = 1 - Math.pow(1 - t, 3);
          angle = startAngle + overshootDelta * eased;
        } else if (elapsed < duration) {
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
          lastHiRef.current   = newHi;
        }
        paint(ctx, angle, sels, rests, computeWiggle(now, wiggleAtRef.current));

        if (elapsed < duration) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          angleRef.current = endAngle;
          runWinnerPulse(endAngle, sels, rests, winnerIdx, () => onDone?.(sels[winnerIdx]));
        }
      };

      rafRef.current = requestAnimationFrame(step);
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

export default RouletteWheel;
