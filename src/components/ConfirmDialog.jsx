// Tiny modal for destructive-action confirmation. Centered, dimmed
// backdrop, two-button row (Cancel + Confirm). Used by any page that
// previously reached for `window.confirm`, which is jarring on modern
// UIs and styled per-OS.
//
// `confirmLabel` defaults to "Confirm" but callers can override
// ("Delete", "Archive", etc.) for clarity at the action level.
// `tone='danger'` paints the confirm button red; `tone='primary'` uses
// the orange brand color for non-destructive flows.

const TONE = {
  danger:  'bg-red-600 hover:bg-red-500',
  primary: 'bg-orange-500 hover:bg-orange-400',
};

export default function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  cancelLabel  = 'Cancel',
  tone = 'danger',
}) {
  const toneClass = TONE[tone] ?? TONE.danger;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-xs p-6 flex flex-col gap-4">
        <p className="text-sm text-gray-700">{message}</p>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 rounded-lg ${toneClass} px-4 py-2 text-sm font-semibold text-white transition-colors`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
