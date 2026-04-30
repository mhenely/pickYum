import { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';

// ── Constants ─────────────────────────────────────────────────

const COLORS = [
  '#E74C3C', '#3498DB', '#2ECC71', '#F39C12', '#9B59B6',
  '#1ABC9C', '#E67E22', '#2980B9', '#27AE60', '#E91E63',
  '#00BCD4', '#FF9800', '#673AB7', '#4CAF50', '#D35400',
  '#795548', '#607D8B', '#FF5722', '#009688', '#3F51B5',
];

const W = 340;          // canvas width / height
const CX = W / 2;       // wheel center x
const CY = W / 2 + 12;  // wheel center y — shifted down to leave room for pointer
const R  = W / 2 - 20;  // wheel radius

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

function paint(ctx, angle, selections, restaurants) {
  const n = selections.length;
  ctx.clearRect(0, 0, W, W);

  if (n === 0) {
    // Empty-state wheel
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, 2 * Math.PI);
    ctx.fillStyle = '#e5e7eb';
    ctx.fill();
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#9ca3af';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Add selections to spin', CX, CY);
  } else {
    const s = (2 * Math.PI) / n;
    const hi = highlightedAt(angle, n);
    const fontSize = n > 12 ? 8 : n > 8 ? 10 : 12;
    const maxChars = n > 12 ? 8 : n > 8 ? 10 : 13;

    // Draw sectors
    for (let i = 0; i < n; i++) {
      const a0 = angle + i * s - Math.PI / 2;
      const a1 = a0 + s;
      const color = COLORS[i % COLORS.length];
      const isHi = i === hi;

      // Sector fill
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = isHi ? lighten(color, 0.4) : color;
      ctx.fill();

      // Sector border
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = isHi ? 3 : 1.5;
      ctx.stroke();

      // Label — rotated to align with sector midpoint radius
      const mid = a0 + s / 2;
      const tr  = R * 0.62;
      ctx.save();
      ctx.translate(CX + tr * Math.cos(mid), CY + tr * Math.sin(mid));
      ctx.rotate(mid + Math.PI / 2);
      ctx.fillStyle = 'rgba(255,255,255,0.96)';
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(trunc(restaurants[selections[i]]?.name ?? '?', maxChars), 0, 0);
      ctx.restore();
    }

    // Outer rim
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, 2 * Math.PI);
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Center hub
    const hub = ctx.createRadialGradient(CX - 5, CY - 5, 2, CX, CY, 22);
    hub.addColorStop(0, '#9ca3af');
    hub.addColorStop(1, '#111827');
    ctx.beginPath();
    ctx.arc(CX, CY, 22, 0, 2 * Math.PI);
    ctx.fillStyle = hub;
    ctx.fill();
    ctx.strokeStyle = '#f3f4f6';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Fixed pointer — red triangle above the wheel, tip pointing down at the rim
  const tipY  = CY - R + 2;
  const baseY = tipY - 22;
  ctx.beginPath();
  ctx.moveTo(CX - 12, baseY);
  ctx.lineTo(CX + 12, baseY);
  ctx.lineTo(CX, tipY);
  ctx.closePath();
  ctx.fillStyle = '#dc2626';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ── Component ─────────────────────────────────────────────────

const RouletteWheel = forwardRef(function RouletteWheel(
  { selections, restaurants, onSpinComplete },
  ref
) {
  const canvasRef = useRef(null);
  const angleRef  = useRef(0);
  const rafRef    = useRef(null);

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

  useImperativeHandle(ref, () => ({
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
      const targetNorm = (2 * Math.PI - (winnerIdx + 0.5) * s + 2 * Math.PI) % (2 * Math.PI);
      const currentNorm = ((angleRef.current % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let delta = targetNorm - currentNorm;
      if (delta <= 0) delta += 2 * Math.PI;

      // Add random full rotations so the landing position is never predictable by feel
      const fullSpins  = 8 + Math.floor(Math.random() * 5); // 8–12 extra full rotations
      const totalDelta = fullSpins * 2 * Math.PI + delta;
      const startAngle = angleRef.current;
      const endAngle   = startAngle + totalDelta;

      // 6–7.5 s total; ease-out cubic keeps the wheel visibly slow near the end
      const duration = 6000 + Math.random() * 1500;
      const t0 = performance.now();

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!ctx) return;

      const step = (now) => {
        const t      = Math.min((now - t0) / duration, 1);
        const eased  = 1 - Math.pow(1 - t, 3);
        const angle  = startAngle + totalDelta * eased;
        angleRef.current = angle;
        paint(ctx, angle, sels, rests);

        if (t < 1) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          angleRef.current = endAngle;
          paint(ctx, endAngle, sels, rests);
          onDone?.(sels[winnerIdx]);
        }
      };

      rafRef.current = requestAnimationFrame(step);
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      width={W}
      height={W}
      className="max-w-full drop-shadow-xl"
    />
  );
});

export default RouletteWheel;
