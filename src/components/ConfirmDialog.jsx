// Tiny modal for destructive-action confirmation. Centered, dimmed
// backdrop, two-button row (Cancel + Confirm). Used by any page that
// previously reached for `window.confirm`, which is jarring on modern
// UIs and styled per-OS.
//
// `confirmLabel` defaults to "Confirm" but callers can override
// ("Delete", "Archive", etc.) for clarity at the action level.
// `tone='danger'` paints the confirm button red; `tone='primary'` uses
// the orange brand color for non-destructive flows.
//
// Backed by Headless UI's <Dialog> so keyboard users get a focus trap,
// Esc-to-cancel, focus restoration on close, and proper ARIA roles —
// none of which the raw <div> version provided. The previous markup
// implemented none of those and would let keyboard focus escape the
// dialog after Tab; screen readers couldn't announce it as a dialog
// either. Visual API (`message`, `onConfirm`, `onCancel`, etc.) is
// unchanged so call sites don't have to migrate.

import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { useRef } from 'react';
import Button from './ui/Button';

// `tone` maps to the Button primitive's variant: 'danger' → red,
// 'primary' → brand orange. Defaults to 'danger' since this dialog is
// most often used for destructive confirms.
const TONE_TO_VARIANT = {
  danger:  'danger',
  primary: 'primary',
};

export default function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  cancelLabel  = 'Cancel',
  tone = 'danger',
}) {
  const confirmVariant = TONE_TO_VARIANT[tone] ?? 'danger';
  // initialFocus → Cancel button. Esc and backdrop click both route
  // through onClose → onCancel so destructive-action dialogs don't
  // confirm by accident.
  const cancelRef = useRef(null);
  return (
    <Dialog
      open
      onClose={onCancel}
      initialFocus={cancelRef}
      className="relative z-50"
    >
      <div className="fixed inset-0 bg-black/50" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center px-4">
        <DialogPanel className="bg-white rounded-2xl shadow-xl w-full max-w-xs p-6 flex flex-col gap-4">
          <DialogTitle className="sr-only">Confirm action</DialogTitle>
          <p className="text-sm text-gray-700">{message}</p>
          <div className="flex gap-2">
            <Button ref={cancelRef} variant="secondary" fullWidth onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button variant={confirmVariant} fullWidth onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
