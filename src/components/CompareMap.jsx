import { useEffect, useMemo } from 'react';
import {
  APIProvider, Map, AdvancedMarker, Pin, useMap,
} from '@vis.gl/react-google-maps';

// Browser Maps JS key. Same env var that powers NearbyMap on the
// Search page. See .env.example for the security restrictions to set
// in Google Cloud Console.
const MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// Distinct mapId from Search's NearbyMap so any future Cloud-side
// styling can diverge. Both default to Google's standard look today.
const MAP_ID = 'pickyum-compare';

/**
 * Re-fits the viewport to enclose all option markers whenever the input
 * set changes. Pre-loaded inside <Map> because `useMap()` needs the map
 * context. Mirrors NearbyMap's FitToBounds but tuned for the smaller
 * option counts on Compare (typically 2-10 pins, vs 20 on Search).
 */
function FitToBounds({ points }) {
  const map = useMap();

  useEffect(() => {
    if (!map || points.length === 0) return;

    // Single point: fitBounds collapses to maxZoom which looks jarring
    // for one pin. Pan + a sensible zoom instead.
    if (points.length === 1) {
      map.setCenter({ lat: points[0].lat, lng: points[0].lng });
      map.setZoom(15);
      return;
    }

    const bounds = new window.google.maps.LatLngBounds();
    points.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }));
    map.fitBounds(bounds, 60); // 60px padding so pins don't hug edges
  }, [map, points]);

  return null;
}

/**
 * Map of the user's options (and optionally favorites) for the Compare
 * page. Renders nothing when the env key is missing or there are no
 * geo-located items — caller is expected to render a placeholder in
 * that empty space.
 *
 * Props:
 *   - items:        Array of { id, name, lat, lng, kind: 'option'|'favorite' }.
 *                   Caller filters out null-coord rows; this component
 *                   trusts what it receives.
 *   - hoveredId:    id whose marker should highlight (string|number|null).
 *   - onMarkerHover:(id|null) => void
 *   - onMarkerClick:(id) => void
 */
export default function CompareMap({ items, hoveredId, onMarkerHover, onMarkerClick }) {
  // Stable initial center — fitBounds takes over on mount. Geographic US
  // center for the rare "no items yet" first paint.
  const initialCenter = useMemo(() => {
    if (items.length > 0) return { lat: items[0].lat, lng: items[0].lng };
    return { lat: 39.8283, lng: -98.5795 };
  }, [items]);

  if (!MAPS_API_KEY) return null;

  return (
    <APIProvider apiKey={MAPS_API_KEY}>
      <Map
        defaultCenter={initialCenter}
        defaultZoom={13}
        mapId={MAP_ID}
        gestureHandling="greedy"
        streetViewControl={false}
        mapTypeControl={false}
        fullscreenControl={false}
      >
        <FitToBounds points={items} />
        {items.map((it) => {
          const isHovered = String(hoveredId) === String(it.id);
          // Favorites use a heart-red palette so they're distinguishable
          // from options at a glance. The Compare-page sidebars use the
          // same heart-vs-orange split, so this preserves the visual
          // language. Hovered pins get a slightly darker + larger pin.
          const palette = it.kind === 'favorite'
            ? { bg: isHovered ? '#dc2626' : '#f87171', border: '#991b1b' }
            : { bg: isHovered ? '#ef4444' : '#f97316', border: '#c2410c' };
          return (
            <AdvancedMarker
              key={it.id}
              position={{ lat: it.lat, lng: it.lng }}
              onClick={() => onMarkerClick?.(it.id)}
            >
              <div
                onMouseEnter={() => onMarkerHover?.(it.id)}
                onMouseLeave={() => onMarkerHover?.(null)}
                className="cursor-pointer"
                title={it.name}
              >
                <Pin
                  background={palette.bg}
                  borderColor={palette.border}
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
