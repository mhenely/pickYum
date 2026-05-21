// Renders the third-party next-step buttons (website / reserve /
// directions / delivery) for a chosen restaurant. Dropped in at peak-
// intent moments (post-pick celebration, restaurant detail modal,
// post-vote result view) so users can act on the decision without
// leaving the flow.
//
// Each link is gated on having enough info to produce a useful URL:
//   - Website     → only when the venue has one on file (most direct)
//   - Directions  → universally available (name + address fallback)
//   - Reserve     → universal (OpenTable search) — paired with the
//                   partner affiliate id when configured
//   - Delivery    → DoorDash + Uber Eats, only when the venue offers
//                   delivery per the Google Places `delivery` flag
//                   (no point sending users to find delivery for a
//                   dine-in-only spot)
//
// `variant='primary'` renders larger CTAs suited to the celebration
// modal's "act now" framing; `variant='compact'` is for the inline
// row inside the restaurant detail modal.

import {
  websiteUrl,
  googleMapsUrl,
  openTableUrl,
  doorDashUrl,
  uberEatsUrl,
} from '../lib/externalLinks';

function LinkButton({ href, icon, label, primary = false }) {
  if (!href) return null;
  const base = 'flex items-center gap-1.5 rounded-lg border transition-colors';
  const palette = primary
    ? 'bg-white border-gray-200 text-gray-900 hover:border-orange-300 hover:bg-orange-50 px-3 py-2.5 text-sm font-semibold shadow-sm'
    : 'bg-white border-gray-200 text-gray-700 hover:border-orange-300 hover:bg-orange-50 px-2.5 py-1.5 text-xs font-medium';
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${base} ${palette}`}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </a>
  );
}

export default function ExternalActions({ restaurant, variant = 'primary' }) {
  if (!restaurant || !restaurant.name) return null;

  const primary = variant === 'primary';
  const offersDelivery = !!(restaurant.delivery || restaurant.takeout);

  const website   = websiteUrl(restaurant);
  const directions= googleMapsUrl(restaurant);
  const reserve   = openTableUrl(restaurant);
  const delivery  = offersDelivery ? doorDashUrl(restaurant) : null;
  const uberEats  = offersDelivery ? uberEatsUrl(restaurant) : null;

  // If nothing is available, render nothing — don't leave an empty
  // labeled section above where the buttons would be.
  if (!website && !directions && !reserve && !delivery && !uberEats) {
    return null;
  }

  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
        Next step
      </p>
      <div className="flex flex-wrap gap-2">
        <LinkButton href={website}    icon="🌐" label="Website"   primary={primary} />
        <LinkButton href={reserve}    icon="🍽"  label="Reserve"   primary={primary} />
        <LinkButton href={directions} icon="🗺"  label="Directions" primary={primary} />
        <LinkButton href={delivery}   icon="🛵" label="DoorDash"  primary={primary} />
        <LinkButton href={uberEats}   icon="🚗" label="Uber Eats" primary={primary} />
      </div>
    </div>
  );
}
