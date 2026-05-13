import { useEffect, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { api } from '../lib/api';
import { PRICE_LABELS } from '../utils/restaurantConstants';
import { normalizeUrl } from '../utils/normalizeUrl';

// Read-only, guest-friendly restaurant detail. Used on the group voting page
// so voters (signed-in or not) can check basic info on a candidate before
// casting their ballot. Distinct from the main RestaurantDetailModal because:
//   - no Redux dependency (voting page voters may be guests)
//   - no auth-gated bits (personal reviews, favorites, "add to options")
//   - fetches by restaurantId, doesn't trust upstream snapshot — gets fresh
//     hours / address / website / rating straight from /api/restaurants/:id

// Lightweight info row helper — keeps each row a one-liner.
const Row = ({ label, value }) => {
  if (!value || value === 'N/A') return null;
  return (
    <div className="flex justify-between items-baseline gap-3 py-1.5 border-b border-gray-100 last:border-b-0">
      <span className="text-xs text-gray-500 shrink-0">{label}</span>
      <span className="text-sm text-gray-800 text-right break-words min-w-0">{value}</span>
    </div>
  );
};

const PublicRestaurantInfoModal = ({ restaurantId, fallback, onClose }) => {
  const [restaurant, setRestaurant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    api.restaurants.get(restaurantId)
      .then(({ restaurant: r }) => { if (!cancelled) setRestaurant(r); })
      .catch((err) => { if (!cancelled) setError(err.message ?? 'Failed to load restaurant info'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [restaurantId]);

  // While the fetch is pending, render whatever the caller already knew about
  // the restaurant (name / type / price from the session snapshot). Means the
  // modal isn't empty for the first ~150ms.
  const r = restaurant ?? fallback ?? {};
  const website = normalizeUrl(r.website);
  const yelp    = normalizeUrl(r.yelpUrl ?? r.yelp);
  // Server returns googleRating / communityRating as stringified Decimals.
  // Coerce to number for display but render as N.N (Decimal precision is 1).
  const googleRating = r.googleRating != null ? Number(r.googleRating) : null;
  const communityRating = r.communityRating != null ? Number(r.communityRating) : null;

  return (
    <Dialog open onClose={onClose} className="relative z-[60]">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-sm rounded-2xl bg-white shadow-xl overflow-hidden">

          {/* Header */}
          <div className="flex justify-between items-start p-5 pb-3 border-b border-gray-100">
            <div className="min-w-0">
              <DialogTitle className="text-base font-bold text-gray-900 truncate">
                {r.name ?? 'Restaurant'}
              </DialogTitle>
              {(r.cuisineType ?? r.type) && (
                <p className="text-xs text-gray-500 mt-0.5">
                  {r.cuisineType ?? r.type}
                  {r.priceLevel ? ` · ${PRICE_LABELS[r.priceLevel]}` : (r.price ? ` · ${PRICE_LABELS[r.price]}` : '')}
                </p>
              )}
            </div>
            <button onClick={onClose} className="ml-3 shrink-0 text-gray-400 hover:text-gray-600">
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {/* Body */}
          <div className="p-5">
            {loading && !restaurant && (
              <p className="text-sm text-gray-400 text-center py-4">Loading details…</p>
            )}
            {error && !restaurant && (
              <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
            )}

            {/* Ratings row — show whatever's available, side-by-side. */}
            {(googleRating != null || communityRating != null) && (
              <div className="flex gap-3 mb-4">
                {googleRating != null && (
                  <div className="flex-1 rounded-lg bg-amber-50 border border-amber-100 p-2.5 text-center">
                    <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wider">Google</p>
                    <p className="text-lg font-black text-amber-700 mt-0.5">★ {googleRating.toFixed(1)}</p>
                  </div>
                )}
                {communityRating != null && (
                  <div className="flex-1 rounded-lg bg-orange-50 border border-orange-100 p-2.5 text-center">
                    <p className="text-[10px] font-semibold text-orange-700 uppercase tracking-wider">Community</p>
                    <p className="text-lg font-black text-orange-700 mt-0.5">★ {communityRating.toFixed(1)}</p>
                  </div>
                )}
              </div>
            )}

            {/* Info rows */}
            <div className="rounded-lg border border-gray-200 px-3 py-1 bg-gray-50">
              <Row label="Hours" value={r.hours} />
              <Row label="Phone" value={r.phone} />
              <Row label="Address" value={r.address} />
              <Row
                label="Website"
                value={website && (
                  <a
                    href={website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-orange-600 hover:text-orange-500 underline-offset-2 hover:underline"
                  >
                    Visit
                  </a>
                )}
              />
              <Row
                label="Yelp"
                value={yelp && (
                  <a
                    href={yelp}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-red-600 hover:text-red-500 underline-offset-2 hover:underline"
                  >
                    On Yelp
                  </a>
                )}
              />
            </div>

            {/* Takeout/Delivery badges — match SearchPage style */}
            {(r.takeout || r.delivery) && (
              <div className="flex gap-2 mt-3 text-xs">
                {r.takeout  && <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded">Takeout</span>}
                {r.delivery && <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded">Delivery</span>}
              </div>
            )}

            {/* Footer note for transparency about what guests can/can't see */}
            <p className="mt-4 text-[10px] text-gray-400 text-center">
              Showing public info only. Personal reviews and ratings require a PickYum account.
            </p>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
};

export default PublicRestaurantInfoModal;
