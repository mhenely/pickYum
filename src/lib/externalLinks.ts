// Deep-link URL builders for third-party restaurant services. Used at
// peak-intent moments (after a coin flip / spin / vote acceptance, or
// from the restaurant detail modal) to turn a chosen pick into an
// actionable next step — book a table, order delivery, get directions.
//
// Affiliate IDs are pulled from Vite env vars (build-time) so partner
// programs can be plugged in once signed up for without touching this
// file. When unset, the URLs fall back to plain search links — the
// feature still works for users; we just don't get credit. This means
// it's safe to deploy without any affiliate setup; revenue layers in
// later as partner programs are activated.
//
// All URL builders return `null` when there isn't enough information
// to construct a useful link (e.g. no name). Callers check for null
// and hide the corresponding button.

import { googleMapsUrl as _googleMapsUrl } from '../utils/googleMapsUrl';

const OPENTABLE_PARTNER_ID = import.meta.env.VITE_OPENTABLE_PARTNER_ID ?? '';
const UBEREATS_AFFILIATE   = import.meta.env.VITE_UBEREATS_AFFILIATE   ?? '';
const DOORDASH_AFFILIATE   = import.meta.env.VITE_DOORDASH_AFFILIATE   ?? '';

export interface RestaurantLite {
  name?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  googlePlaceId?: string | null;
  phone?: string | null;
  website?: string | null;
  takeout?: boolean;
  delivery?: boolean;
}

// Trim and validate input — empty strings and 'N/A' sentinels (legacy
// pre-cleanup data) get treated as absent.
function clean(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'N/A') return null;
  return trimmed;
}

/**
 * Restaurant's own website, normalized to a clickable URL. The single
 * most direct call-to-action — bypasses every aggregator and goes
 * straight to the venue. Returns null when no website is on file.
 */
export function websiteUrl(r: RestaurantLite): string | null {
  const raw = clean(r.website);
  if (!raw) return null;
  // Some sources store bare hostnames ("example.com") instead of full
  // URLs. Prepend https:// when no protocol is present.
  return raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
}

/**
 * Re-export of the existing `utils/googleMapsUrl` so all third-party
 * deep-link builders are reachable from one place. The util predates
 * this module and is still imported directly from a few callers
 * (RestaurantDetailModal); keeping that direct path lets us migrate
 * incrementally rather than touch every site at once.
 */
export const googleMapsUrl = _googleMapsUrl;

/**
 * OpenTable reservation search. Affiliate `rid` parameter is appended
 * when configured — the partner program tracks attribution via this
 * query string. Falls back to a plain search when no partner id.
 */
export function openTableUrl(r: RestaurantLite): string | null {
  const name = clean(r.name);
  if (!name) return null;
  const params = new URLSearchParams({ term: name });
  if (r.lat != null && r.lng != null) {
    params.set('latitude', String(r.lat));
    params.set('longitude', String(r.lng));
  }
  if (OPENTABLE_PARTNER_ID) {
    params.set('rid', OPENTABLE_PARTNER_ID);
  }
  return `https://www.opentable.com/s?${params.toString()}`;
}

/**
 * DoorDash store search. They don't expose a public affiliate program
 * today; the env hook is structured anyway so it can be enabled
 * without a code change when a partnership lands.
 */
export function doorDashUrl(r: RestaurantLite): string | null {
  const name = clean(r.name);
  if (!name) return null;
  const params = new URLSearchParams({ query: name });
  if (DOORDASH_AFFILIATE) {
    params.set('utm_source', DOORDASH_AFFILIATE);
  }
  return `https://www.doordash.com/search/store/?${params.toString()}`;
}

/**
 * Uber Eats search. Like DoorDash, no public affiliate program, but
 * the env hook is there if Impact / Awin partnerships are activated.
 */
export function uberEatsUrl(r: RestaurantLite): string | null {
  const name = clean(r.name);
  if (!name) return null;
  const params = new URLSearchParams({ q: name });
  if (UBEREATS_AFFILIATE) {
    params.set('utm_source', UBEREATS_AFFILIATE);
  }
  return `https://www.ubereats.com/search?${params.toString()}`;
}

/**
 * Tap-to-call. Phone numbers may include formatting characters that
 * iOS / Android handle inconsistently — strip everything except
 * digits and a leading + so `tel:` URLs always dial cleanly.
 */
export function phoneUrl(r: RestaurantLite): string | null {
  const phone = clean(r.phone);
  if (!phone) return null;
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}
