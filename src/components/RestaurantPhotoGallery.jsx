import { useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { placePhotoUrl } from '../lib/api';

// Photo carousel for the detail modal.
//
// Extracted from RestaurantDetailModal as the first cut of its
// decomposition (TIER_2_3_PLAN.md #10). This component is the cleanest
// thing to extract because it doesn't share state with any other modal
// section — no hooks crossing the boundary, no props that need
// threading. The modal just `<RestaurantPhotoGallery photos={r.photos}
// restaurantName={r.name} />` and forgets about it.
//
// Behavior notes (preserved from the original inline version):
//   - Wraps in both directions: pressing prev from index 0 lands on
//     the last photo, and vice versa.
//   - Resets to the first photo each time the modal reopens (state
//     resets when the component unmounts/remounts).
//   - All photos go through our /api/places/photo proxy so the Google
//     API key stays server-side.
//   - Defensive filter on `name` — if a photo entry is missing its
//     proxy-URL input we skip it rather than calling the proxy with
//     an invalid value.
//   - Position counter sits TOP-right (not bottom-right) because the
//     thumbnail strip below the hero butted right against the bottom
//     edge of the hero, leaving no visual breathing room. Matches
//     Google Maps / Instagram / Airbnb convention.
export default function RestaurantPhotoGallery({ photos, restaurantName }) {
  const [active, setActive] = useState(0);
  const valid = (photos ?? []).filter((p) => p?.name);
  if (valid.length === 0) return null;
  const safeActive = Math.min(active, valid.length - 1);
  const hero = valid[safeActive];
  const hasMultiple = valid.length > 1;

  const prev = () => setActive((i) => (i - 1 + valid.length) % valid.length);
  const next = () => setActive((i) => (i + 1) % valid.length);

  return (
    <div className="rounded-t-xl overflow-hidden">
      <div className="relative h-48 bg-gray-100">
        <img
          key={hero.name}
          src={placePhotoUrl(hero, 1200)}
          alt={restaurantName}
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
        {hasMultiple && (
          <>
            {/* Prev / next chevrons — fixed-position overlay, semi-
                transparent so the photo shows through. type="button"
                so they don't accidentally submit any parent form
                (the modal isn't a form today, but defensive). */}
            <button
              type="button"
              onClick={prev}
              aria-label="Previous photo"
              className="absolute left-2 top-1/2 -translate-y-1/2 h-8 w-8 flex items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
            >
              <ChevronLeftIcon className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={next}
              aria-label="Next photo"
              className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 flex items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
            >
              <ChevronRightIcon className="h-5 w-5" />
            </button>
            <span className="absolute top-2 right-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white tabular-nums">
              {safeActive + 1} / {valid.length}
            </span>
          </>
        )}
      </div>
      {hasMultiple && (
        <div className="flex gap-1 p-2 bg-gray-50 overflow-x-auto">
          {valid.slice(0, 5).map((ph, i) => (
            <button
              key={ph.name}
              type="button"
              onClick={() => setActive(i)}
              className={`relative h-14 w-20 shrink-0 overflow-hidden rounded transition-all ${
                i === safeActive ? 'ring-2 ring-orange-500' : 'opacity-80 hover:opacity-100'
              }`}
            >
              <img
                src={placePhotoUrl(ph, 200)}
                alt=""
                loading="lazy"
                className="absolute inset-0 h-full w-full object-cover"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
