import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { api } from '../lib/api';
import { mergeCustomIntoPlace, setMatchOptOut } from '../redux/slices/userInfoSlice';

// Banner + modal pair shown above the nearby-search results when the
// detection scan finds custom restaurants that look like matches for
// Google Place results. Three actions per match:
//
//   - "Yes, link them"        → materialize the Place (idempotent),
//                                call /restaurants/:customId/link-to-place,
//                                then mergeCustomIntoPlace in Redux
//   - "Not a match"           → just drop this suggestion (session-only,
//                                will reappear on the next search)
//   - "Stop asking"           → PATCH match-settings on the custom row
//                                so it's excluded from future scans
//
// The banner stays collapsed (one-liner) until clicked; the dialog
// renders side-by-side rows so the user can compare the custom name
// + address with the Google result before committing. Merging is
// destructive (custom row gets deleted server-side if private and
// unreferenced) so we want an explicit confirmation step.

export default function MatchSuggestionsBanner({ matches, onMatchHandled }) {
  const dispatch = useDispatch();
  // null = banner only / closed; object = modal open on this match.
  const [activeMatch, setActiveMatch] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Dismissed matches stay hidden for the session (not persisted —
  // "Not a match" is a soft skip; user can search again to surface
  // the same suggestion if they change their mind).
  const [dismissed, setDismissed] = useState(() => new Set());

  // Filter out anything the user already acted on. Empty after every
  // suggestion is handled — banner self-hides via the parent check.
  const visible = matches.filter((m) => !dismissed.has(m.customId + '::' + m.place.googlePlaceId));
  if (visible.length === 0) return null;

  const closeModal = () => {
    if (busy) return; // don't close mid-write
    setActiveMatch(null);
    setError('');
  };

  const markHandled = (m) => {
    setDismissed((prev) => new Set(prev).add(m.customId + '::' + m.place.googlePlaceId));
    setActiveMatch(null);
    setError('');
    onMatchHandled?.(m);
  };

  // "Yes, link them" — full merge flow.
  const handleAccept = async () => {
    if (!activeMatch) return;
    setBusy(true);
    setError('');
    try {
      // 1. Materialize the Place (idempotent — server findUnique by
      //    googlePlaceId, creates only if missing). Mirrors what
      //    SearchPage does when a user adds a Place to options.
      const place = activeMatch.place;
      const { restaurant: placeRow } = await api.restaurants.create({
        name:          place.name,
        googlePlaceId: place.googlePlaceId,
        cuisineType:   place.cuisineType ?? undefined,
        priceLevel:    place.priceLevel ?? undefined,
        googleRating:  place.googleRating ?? undefined,
        ratingCount:   place.ratingCount ?? undefined,
        photos:        place.photos && place.photos.length ? place.photos : undefined,
        regularOpeningHours: place.regularOpeningHours ?? undefined,
        phone:         place.phone   ?? undefined,
        website:       place.website ?? undefined,
        address:       place.address ?? undefined,
        takeout:       place.takeout  ?? false,
        delivery:      place.delivery ?? false,
        lat:           place.lat ?? undefined,
        lng:           place.lng ?? undefined,
      });

      // 2. Server-side merge: migrates this user's collection refs
      //    from the custom row to the Place row, deletes the
      //    custom row if private + unreferenced.
      await api.restaurants.linkToPlace(
        Number(activeMatch.customId),
        { placeRestaurantId: placeRow.id },
      );

      // 3. Mirror in Redux: re-point favorites/options/etc. and
      //    drop the custom row from customRestaurants. The place
      //    row was already added to customRestaurants by the
      //    materialize call (SearchPage's flow handles that too
      //    — addCustomRestaurant is idempotent on id).
      dispatch(mergeCustomIntoPlace({
        customId: activeMatch.customId,
        placeId:  String(placeRow.id),
      }));

      markHandled(activeMatch);
    } catch (err) {
      setError(err?.message ?? 'Could not link the restaurants.');
    } finally {
      setBusy(false);
    }
  };

  // "Stop asking" — flip the opt-out flag for THIS custom row so
  // future searches skip it. Also dismisses the current suggestion.
  const handleStopAsking = async () => {
    if (!activeMatch) return;
    setBusy(true);
    setError('');
    try {
      await api.restaurants.setMatchSettings(
        Number(activeMatch.customId),
        { excludeFromPlaceMatching: true },
      );
      dispatch(setMatchOptOut({
        id: activeMatch.customId,
        excludeFromPlaceMatching: true,
      }));
      markHandled(activeMatch);
    } catch (err) {
      setError(err?.message ?? 'Could not save the setting.');
    } finally {
      setBusy(false);
    }
  };

  // "Not a match" — just skip this one for the session.
  const handleSkip = () => markHandled(activeMatch);

  return (
    <>
      <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 px-4 py-3">
        <p className="text-sm font-semibold text-orange-700 mb-2">
          We found {visible.length} possible match{visible.length === 1 ? '' : 'es'} for your saved restaurants
        </p>
        <ul className="flex flex-col gap-1.5">
          {visible.map((m) => (
            <li
              key={`${m.customId}::${m.place.googlePlaceId}`}
              className="flex items-center justify-between gap-2 text-xs text-orange-900/80"
            >
              <span className="truncate">
                <span className="font-semibold">{m.customName}</span>
                <span className="opacity-70"> may be </span>
                <span className="font-semibold">{m.place.name}</span>
              </span>
              <button
                type="button"
                onClick={() => setActiveMatch(m)}
                className="shrink-0 rounded-md border border-orange-300 bg-white px-2 py-0.5 text-[11px] font-medium text-orange-700 hover:bg-orange-100 transition-colors"
              >
                Review
              </button>
            </li>
          ))}
        </ul>
      </div>

      {activeMatch && (
        <Dialog open onClose={closeModal} className="relative z-50">
          <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
          <div className="fixed inset-0 flex items-center justify-center p-4">
            <DialogPanel className="w-full max-w-md rounded-xl bg-white shadow-xl">
              <div className="flex items-start justify-between p-5 pb-3">
                <DialogTitle className="text-base font-bold text-gray-900">
                  Are these the same restaurant?
                </DialogTitle>
                <button
                  onClick={closeModal}
                  disabled={busy}
                  className="text-gray-400 hover:text-gray-600 disabled:opacity-40"
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>

              <div className="px-5 pb-3 flex flex-col gap-2">
                {/* Your custom row */}
                <div className="rounded-lg border border-gray-200 px-3 py-2">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Your saved</p>
                  <p className="text-sm font-semibold text-gray-900 mt-0.5">{activeMatch.customName}</p>
                  {/* address optional — only render when present */}
                </div>

                {/* Google result */}
                <div className="rounded-lg border border-orange-200 bg-orange-50/50 px-3 py-2">
                  <p className="text-[10px] font-semibold text-orange-600 uppercase tracking-wider">Google result</p>
                  <p className="text-sm font-semibold text-gray-900 mt-0.5">{activeMatch.place.name}</p>
                  {activeMatch.place.address && (
                    <p className="text-xs text-gray-500 mt-0.5">{activeMatch.place.address}</p>
                  )}
                  {activeMatch.place.cuisineType && (
                    <p className="text-xs text-gray-500 mt-0.5">{activeMatch.place.cuisineType}</p>
                  )}
                </div>

                {/* Linking effects — set expectations before the user clicks */}
                <p className="text-[11px] text-gray-500 italic">
                  Linking moves your reviews, favorites status, and history from your saved entry to the Google result.
                  Your custom entry will be removed.
                </p>

                {error && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-1.5">
                    {error}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-2 px-5 pb-5">
                <button
                  type="button"
                  onClick={handleAccept}
                  disabled={busy}
                  className="flex-1 rounded-lg bg-orange-500 text-white px-3 py-2 text-sm font-semibold hover:bg-orange-400 disabled:opacity-50 transition-colors"
                >
                  {busy ? 'Linking…' : 'Yes, link them'}
                </button>
                <button
                  type="button"
                  onClick={handleSkip}
                  disabled={busy}
                  className="flex-1 rounded-lg border border-gray-300 bg-white text-gray-700 px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
                >
                  Not a match
                </button>
                <button
                  type="button"
                  onClick={handleStopAsking}
                  disabled={busy}
                  className="w-full rounded-lg border border-gray-200 bg-white text-gray-500 px-3 py-2 text-xs font-medium hover:bg-gray-50 hover:text-gray-700 disabled:opacity-50 transition-colors"
                >
                  Stop asking about {activeMatch.customName}
                </button>
              </div>
            </DialogPanel>
          </div>
        </Dialog>
      )}
    </>
  );
}
