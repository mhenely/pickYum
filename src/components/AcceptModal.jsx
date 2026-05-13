import { useState, useMemo } from "react";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import RatingDisplay from "./RatingDisplay";
import ScheduleModal from "./ScheduleModal";
import InfoRow from "./InfoRow";
import { PRICE_LABELS } from "../utils/restaurantConstants";

const AcceptModal = ({ restaurantId, userInfo, onClose, restaurantMap = {} }) => {
  const r = restaurantMap[restaurantId];
  const [copied, setCopied] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);

  const reviews = useMemo(
    () => userInfo.reviews[String(restaurantId)] ?? [],
    [userInfo.reviews, restaurantId],
  );
  const avgRating = useMemo(
    () => reviews.length ? reviews.reduce((acc, rv) => acc + rv.rating, 0) / reviews.length : null,
    [reviews],
  );

  if (!r) return null;

  const handleShare = async () => {
    const text = `pickYum chose ${r.name} for me tonight!`;
    if (navigator.share) {
      try { await navigator.share({ title: 'pickYum', text, url: window.location.origin }); } catch { /* user cancelled */ }
    } else {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } catch { /* clipboard unavailable */ }
    }
  };

  return (
    <>
    <Dialog open={true} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-lg rounded-xl bg-white shadow-xl flex flex-col max-h-[85vh] overflow-y-auto">

          {/* ── Banner ─────────────────────────────────────────── */}
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

            {/* ── Ratings ────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full bg-orange-100 text-orange-700 text-xs font-semibold">{r.type}</span>
              <RatingDisplay
                restaurantId={restaurantId}
                googleRating={r.rating ?? null}
                personalRating={avgRating}
                personalReviews={reviews}
                restaurantName={r.name}
              />
            </div>

            <hr className="border-gray-100" />

            {/* ── Info grid ──────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-x-8 gap-y-4">
              <InfoRow label="Price"   value={PRICE_LABELS[r.price]} />
              <InfoRow label="Opens"   value={r.hours} />
              <InfoRow label="Phone"   value={r.phone}   href={`tel:${r.phone}`} />
              <InfoRow label="Website" value={r.website} href={`https://${r.website}`} external />
              <InfoRow label="Yelp"    value={r.yelp}    href={`https://${r.yelp}`}    external />
            </div>

            {/* ── Service availability ───────────────────────────── */}
            <div className="flex gap-2">
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${r.takeout ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400 line-through"}`}>Takeout</span>
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${r.delivery ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400 line-through"}`}>Delivery</span>
            </div>

            {/* ── User reviews ───────────────────────────────────── */}
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
                onClick={onClose}
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
                title="Share this pick"
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
        onClose={() => setShowSchedule(false)}
      />
    )}
    </>
  );
};

export default AcceptModal;
