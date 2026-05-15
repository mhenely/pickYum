import { useEffect, useMemo } from 'react';
import {
  APIProvider, Map, AdvancedMarker, Pin, useMap,
} from '@vis.gl/react-google-maps';

// The Maps JS key is browser-bundled. It MUST be a different key from the
// server's GOOGLE_PLACES_API_KEY and locked to HTTP-referrer restrictions
// in Google Cloud Console — see .env.example.
const MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// A map id is required by AdvancedMarker. Any non-empty string works for
// the default look; supplying a Cloud-configured map id swaps in custom
// styling. Pickyum doesn't need that yet.
const MAP_ID = 'pickyum-search';

/**
 * Re-fits the map's viewport whenever `places` or `center` change so the
 * markers on the current pagination page are all visible. Sits inside
 * <Map> because `useMap()` needs the map context.
 *
 * Pagination cycles through different result subsets, so this runs on
 * every page change — that's intentional. Each page should feel like its
 * own little overview.
 */
function FitToBounds({ places, center }) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    const pts = places.filter((p) => p.lat != null && p.lng != null);

    // Empty page (filters knocked everything out) — fall back to the
    // searched address center at a reasonable zoom.
    if (pts.length === 0) {
      if (center) {
        map.setCenter(center);
        map.setZoom(13);
      }
      return;
    }

    // Single point — fitBounds collapses to maxZoom which is jarring. Pan
    // and pick a sensible zoom manually.
    if (pts.length === 1) {
      map.setCenter({ lat: pts[0].lat, lng: pts[0].lng });
      map.setZoom(15);
      return;
    }

    const bounds = new window.google.maps.LatLngBounds();
    pts.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }));
    map.fitBounds(bounds, 60); // 60px padding so markers don't hug edges
  }, [map, places, center]);

  return null;
}

/**
 * Map of the currently-visible (paginated) nearby results. Designed to
 * sit beside the cards grid on Search; renders nothing if the API key is
 * missing so the page still works in dev without one.
 *
 * Props:
 *   - places:     PlacesRestaurant[] for the *current page only*. The map
 *                 only ever shows what the user can also see in cards.
 *   - center:     { lat, lng } — geocoded search center, fallback for the
 *                 empty-result case.
 *   - hoveredId:  googlePlaceId of the currently hovered card (recolors
 *                 the matching pin). null when nothing is hovered.
 *   - onMarkerHover: (placeId | null) => void — fires on enter/leave so
 *                 SearchPage can ring the matching card.
 *   - onMarkerClick: (place) => void — fires on click; SearchPage routes
 *                 it through the existing handleOpenPlaceDetail flow so
 *                 the detail modal opens like a card click would.
 */
export default function NearbyMap({
  places,
  center,
  hoveredId,
  onMarkerHover,
  onMarkerClick,
}) {
  // Stable default center for the initial render. fitBounds takes over
  // once Map mounts, so this only matters for the very first paint.
  // Memoized so a parent re-render with a fresh object literal doesn't
  // force the Map to reset.
  const initialCenter = useMemo(
    () => center ?? { lat: 39.8283, lng: -98.5795 }, // geographic US center
    [center],
  );

  // Hide the map entirely when the env var isn't set. The page is still
  // usable without it; this matches how Sentry / Resend fail open.
  // NB: this early return MUST come after every hook call to satisfy the
  // rules-of-hooks lint — moving it above will silently break Map on the
  // first render once the key gets set.
  if (!MAPS_API_KEY) return null;

  return (
    <APIProvider apiKey={MAPS_API_KEY}>
      <Map
        defaultCenter={initialCenter}
        defaultZoom={13}
        mapId={MAP_ID}
        gestureHandling="greedy"
        disableDefaultUI={false}
        // Cleaner default UI: keep zoom controls, drop street view +
        // map-type selector since neither helps a restaurant browse.
        streetViewControl={false}
        mapTypeControl={false}
        fullscreenControl={false}
      >
        <FitToBounds places={places} center={center} />
        {places
          .filter((p) => p.lat != null && p.lng != null)
          .map((p) => {
            const isHovered = hoveredId === p.googlePlaceId;
            return (
              <AdvancedMarker
                key={p.googlePlaceId}
                position={{ lat: p.lat, lng: p.lng }}
                onClick={() => onMarkerClick?.(p)}
                // Marker hover events fire on the inner <Pin> via DOM
                // listeners — see below. AdvancedMarker doesn't expose
                // its own onMouseEnter.
              >
                <div
                  onMouseEnter={() => onMarkerHover?.(p.googlePlaceId)}
                  onMouseLeave={() => onMarkerHover?.(null)}
                  className="cursor-pointer"
                >
                  <Pin
                    background={isHovered ? '#ef4444' : '#f97316'}
                    borderColor={isHovered ? '#b91c1c' : '#c2410c'}
                    glyphColor="#ffffff"
                    scale={isHovered ? 1.2 : 1}
                  />
                </div>
              </AdvancedMarker>
            );
          })}
      </Map>
    </APIProvider>
  );
}
