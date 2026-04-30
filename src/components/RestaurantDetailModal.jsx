import { Dialog, DialogPanel } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useDispatch } from 'react-redux';
import { addUserSelection, removeUserSelection, updateUserFavorites } from '../redux/slices/userInfoSlice';
import useCurrentUser from '../hooks/useCurrentUser';

const PRICE_LABELS = { 1: '$', 2: '$$', 3: '$$$', 4: '$$$$' };
const sid = (id) => String(id);
const mean = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;

const InfoRow = ({ label, value, href, external }) => (
  <div>
    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">
      {label}
    </p>
    {href ? (
      <a
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        className="text-sm text-indigo-600 hover:underline break-all"
      >
        {value}
      </a>
    ) : (
      <p className="text-sm text-gray-800 font-medium">{value}</p>
    )}
  </div>
);

const RestaurantDetailModal = ({ restaurantId, restaurantMap, onClose }) => {
  const dispatch = useDispatch();
  const userInfo = useCurrentUser();

  const r = restaurantMap?.[restaurantId];
  if (!r) return null;

  const reviews   = userInfo.reviews[sid(restaurantId)] || [];
  const avgRating = reviews.length ? mean(reviews.map((rv) => rv.rating)) : null;
  const isFavorite = userInfo.favorites.map(sid).includes(sid(restaurantId));
  const isSelected = userInfo.selections.map(sid).includes(sid(restaurantId));

  return (
    <Dialog open onClose={onClose} className="relative z-50">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />

      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-lg rounded-xl bg-white shadow-xl flex flex-col max-h-[90vh]">

          {/* ── Header ───────────────────────────────────────── */}
          <div className="flex justify-between items-start p-6 pb-4">
            <div className="min-w-0">
              <h2 className="text-2xl font-bold text-gray-900 leading-tight">{r.name}</h2>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <span className="px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-semibold">
                  {r.type}
                </span>
                {r.rating != null && (
                  <span className="text-sm text-amber-500 font-semibold">
                    ★ {r.rating}{' '}
                    <span className="text-gray-400 font-normal text-xs">overall</span>
                  </span>
                )}
                {avgRating !== null && (
                  <span className="text-sm text-indigo-500 font-semibold">
                    ★ {avgRating.toFixed(1)}{' '}
                    <span className="text-gray-400 font-normal text-xs">your avg</span>
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className="ml-4 shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          {/* ── Scrollable body ──────────────────────────────── */}
          <div className="overflow-y-auto px-6 pb-6 flex flex-col gap-5">
            <hr className="border-gray-100" />

            {/* Info grid */}
            <div className="grid grid-cols-2 gap-x-8 gap-y-4">
              <InfoRow label="Price"   value={PRICE_LABELS[r.price] ?? '—'} />
              <InfoRow label="Opens"   value={r.hours ?? '—'} />
              {r.phone   && <InfoRow label="Phone"   value={r.phone}   href={`tel:${r.phone}`} />}
              {r.website && <InfoRow label="Website" value={r.website} href={`https://${r.website}`} external />}
              {r.yelp    && <InfoRow label="Yelp"    value={r.yelp}    href={`https://${r.yelp}`}    external />}
            </div>

            {/* Service availability */}
            <div className="flex gap-2">
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                r.takeout ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400 line-through'
              }`}>
                Takeout
              </span>
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                r.delivery ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400 line-through'
              }`}>
                Delivery
              </span>
            </div>

            {/* Action buttons */}
            <div className="flex gap-3">
              <button
                onClick={() =>
                  isSelected
                    ? dispatch(removeUserSelection(sid(restaurantId)))
                    : dispatch(addUserSelection(sid(restaurantId)))
                }
                className={[
                  'flex-1 rounded-lg py-2 text-sm font-semibold transition-colors',
                  isSelected
                    ? 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-200'
                    : 'bg-indigo-600 text-white hover:bg-indigo-500',
                ].join(' ')}
              >
                {isSelected ? 'Remove from Selections' : 'Add to Selections'}
              </button>
              <button
                onClick={() =>
                  dispatch(updateUserFavorites({ restaurantId: sid(restaurantId), userId: userInfo.id }))
                }
                className={[
                  'flex-1 rounded-lg py-2 text-sm font-semibold transition-colors border',
                  isFavorite
                    ? 'bg-red-50 text-red-600 hover:bg-red-100 border-red-200'
                    : 'bg-white text-gray-600 hover:bg-gray-50 border-gray-200',
                ].join(' ')}
              >
                {isFavorite ? '♥ Unfavorite' : '♡ Favorite'}
              </button>
            </div>

            {/* User reviews */}
            {reviews.length > 0 && (
              <div className="border-t border-gray-100 pt-4">
                <p className="text-sm font-semibold text-gray-700 mb-3">
                  Your Reviews{' '}
                  <span className="ml-1 text-xs font-normal text-gray-400">({reviews.length})</span>
                </p>
                <div className="flex flex-col gap-2 max-h-48 overflow-y-auto pr-1">
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
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
};

export default RestaurantDetailModal;
