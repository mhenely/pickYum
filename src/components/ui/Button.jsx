// Canonical button primitive. Pre-Phase-5 the codebase had ~6 visually-
// distinct primary-button styles (rounded-md vs -lg, px-3/py-1.5 vs
// px-4/py-2, solid orange vs gradient) drifting across pages — each
// fine on its own, cumulatively "patchwork." This component locks
// the tokens so new callers don't have to make the same micro-
// decisions, and old hand-rolled buttons can migrate at their own pace.
//
// Tokens (use these for any new buttons; migrate old ones opportunistically):
//   variant=primary   → orange→red gradient (brand CTA; "Sign up", "Create")
//   variant=secondary → bordered + light gray (cancel, "Skip", alt CTA)
//   variant=danger    → solid red (destructive: delete/archive/disband)
//   variant=ghost     → text-only, no border/fill (low-emphasis links)
//
//   size=sm           → px-3 py-1.5 text-xs   (chips, inline actions)
//   size=md (default) → px-4 py-2   text-sm   (default form/header CTA)
//   size=lg           → px-5 py-2.5 text-sm   (page-primary, modal submit)
//
// Radius is fixed at rounded-lg for all variants — rounded-md is no
// longer used for buttons. Cards still use rounded-xl; modals
// rounded-2xl; that hierarchy is intentional (cards softer than buttons,
// modals softest).

import { forwardRef } from 'react';

const VARIANTS = {
  primary:
    'bg-gradient-to-br from-orange-500 to-red-500 hover:from-orange-400 hover:to-red-400 text-white font-semibold shadow-brand-sm',
  secondary:
    'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 font-medium',
  danger:
    'bg-red-600 hover:bg-red-500 text-white font-semibold',
  ghost:
    'text-gray-600 hover:text-gray-900 hover:bg-gray-50 font-medium',
};

const SIZES = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-sm',
};

// forwardRef so callers (eg ConfirmDialog) can pass initialFocus refs
// through to the underlying <button>. Without this, Headless UI's
// initialFocus mechanism would receive a ref to nothing.
const Button = forwardRef(function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  fullWidth = false,
  className = '',
  children,
  ...rest
}, ref) {
  const v = VARIANTS[variant] ?? VARIANTS.primary;
  const s = SIZES[size] ?? SIZES.md;
  return (
    <button
      ref={ref}
      type={type}
      className={[
        'rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-1',
        v,
        s,
        fullWidth ? 'w-full' : '',
        className,
      ].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
});

export default Button;
