import { useSelector, useDispatch } from 'react-redux';
import { dismissChosenCelebration } from '../redux/slices/celebrationSlice';
import { PRICE_LABELS } from '../utils/restaurantConstants';

// Global "Tonight you're going to {name}!" celebration. Mounted once
// at the app root and subscribes to celebrationSlice.chosenId; any
// page can pop the celebration by dispatching showChosenCelebration.
//
// Replaces the previously page-local ChosenModal that only lived on
// the Compare page. Now the same celebration fires from:
//   - Compare page's Choose Now (per-panel button)
//   - Detail modal's Choose Now in the default action row (Search,
//     History, Insights, Socials, nav options chip, etc.)
//   - Coin-flip / roulette result on the Choose page
// — consistent UX everywhere a user commits to a restaurant.
//
// Data resolution: the celebration just needs name/type/price/hours/
// takeout/delivery — the same shape as the in-memory `customRestaurants`
// row. We pull from there. Falls back to nothing if the id isn't in
// the map (e.g. a guest who chose a nearby search result before
// materializing) — the user will still see the action's effect on
// the page, just no celebration popup.
export default function ChosenCelebration() {
  const dispatch = useDispatch();
  const chosenId = useSelector((s) => s.celebration?.chosenId ?? null);
  const restaurant = useSelector((s) =>
    chosenId ? s.userInfo.customRestaurants[String(chosenId)] : null,
  );

  if (!chosenId || !restaurant) return null;

  const onClose = () => dispatch(dismissChosenCelebration());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/40"
        aria-hidden="true"
        onClick={onClose}
      />
      <div className="relative w-full max-w-sm rounded-2xl bg-white shadow-2xl overflow-hidden">
        <div className="bg-green-50 border-b border-green-100 px-6 py-5 flex justify-between items-start">
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-1">
              Tonight you're going to
            </p>
            <h2 className="text-2xl font-bold text-gray-900">{restaurant.name}</h2>
            {restaurant.type && (
              <p className="text-sm text-gray-500 mt-0.5">{restaurant.type}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 shrink-0 mt-1 text-lg leading-none"
          >
            ✕
          </button>
        </div>
        <div className="px-6 py-5 flex flex-col gap-3">
          {/* Price + Hours mini-row. Hours falls back to em-dash when
              the row has no value (custom rows often don't); price
              defaults to '—' when no priceLevel is set. */}
          <div className="flex gap-4 text-sm text-gray-700">
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Price</p>
              {PRICE_LABELS[restaurant.price] ?? '—'}
            </div>
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Hours</p>
              {restaurant.hours && restaurant.hours !== 'N/A' ? restaurant.hours : '—'}
            </div>
          </div>
          {/* Service availability — matches the chips users see on
              cards/modals, just smaller. */}
          <div className="flex gap-2">
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
              restaurant.takeout ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400 line-through'
            }`}>
              Takeout
            </span>
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
              restaurant.delivery ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400 line-through'
            }`}>
              Delivery
            </span>
          </div>
          <button
            onClick={onClose}
            className="mt-1 w-full rounded-lg bg-green-600 py-2.5 text-sm font-semibold text-white hover:bg-green-500 transition-colors"
          >
            Let's go!
          </button>
        </div>
      </div>
    </div>
  );
}
