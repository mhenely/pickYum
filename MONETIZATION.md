# Monetization Roadmap

A living strategy doc covering future revenue paths for PickYum, the technical
work each one requires, and the order to ship them in. **Nothing in here is
committed** — this is a plan, not a contract. Update the sequencing table at
the bottom as user counts and product evidence change.

---

## Guiding principles

1. **User-aligned, not extractive.** Every revenue path should make the
   product better for the user paying — or, if the payer is a third party
   (restaurant, affiliate), the user should still come out neutral or
   ahead. No dark patterns, no hidden tracking, no data-broker plays.
2. **Trust before extraction.** Free, useful, reliable product first. The
   product needs to earn the right to ask for money. Premium gating
   features users already enjoy free is reversible only at significant
   reputation cost — be deliberate about what goes behind a paywall.
3. **Direct B2B data sales are off the table.** Selling aggregated user
   behavioral data to third parties, even anonymized, is a fast path to
   legal exposure (GDPR / CCPA), bad press, and user attrition. The
   ["Strategy 6 — explicitly NOT doing"](#strategy-6--what-were-explicitly-not-doing)
   section below documents why so future-us doesn't re-derive the answer.

---

## Where we are right now

### Data foundations already in place

| Asset | Built? | Notes |
|---|---|---|
| Per-user decision history (`UserAccepted`) | ✅ | Append-only; one row per accept. |
| Consideration-set snapshot per decision | ✅ | `UserAccepted.selectionsSnapshot` — captures what was in the running. Enabling: competitor analysis, "always considered never chosen" lists, mind-share metrics. |
| Decision method per acceptance | ✅ | `UserAccepted.chooseMethod` — flip / spin / vote / surprise / direct. Enables method-breakdown analytics and method-segmented metrics. |
| Group voting + ballot persistence | ✅ | `GroupEventResult.ballots`, `voterMeta`, `irvRounds` — captures per-voter behavior for past group decisions. |
| Restaurant catalog with Google Place IDs | ✅ | `Restaurant.googlePlaceId` — pivot for affiliate / restaurant-account matching. |
| User Insights aggregation endpoint | ✅ | `GET /api/users/me/insights` — backend rollup powering the `/insights` page. |

### What we don't have yet (no work done)

- **Payments infrastructure** — no Stripe / billing integration anywhere.
- **Restaurant accounts** — no auth flow distinct from end-users; no
  ownership / verification model.
- **Ad inventory / sponsored placement primitives** — no schema, no
  serving, no tracking.
- **Affiliate program enrollment** — no OpenTable / Resy / Tock
  partnerships set up; no external-ID columns on `Restaurant`.

---

## Strategy 1 — PickYum Plus (premium user subscription)

**Pitch.** $3–5/mo unlocks deeper personal Insights (full history vs. 30
days, friend comparisons, cuisine trends, exportable CSV), unlimited
group voting, larger group sizes, ad-free experience, custom themes for
group events. Most direct path to consumer revenue and the cleanest
extension of work already shipped.

**Unit economics (rough).** If conversion lands at 3–5% of monthly
actives and ARPU at $4/mo:
- 200 DAU × 3% × $4/mo = ~$24/mo (proof of concept)
- 1,000 DAU × 5% × $4/mo = ~$200/mo
- 10,000 DAU × 5% × $4/mo = ~$2,000/mo

Strava and Duolingo run roughly this model. Note: subscription conversion
is famously hard to predict. Treat these as ceilings, not forecasts.

**Prerequisites.**
- ~200 monthly active users (smaller cohorts have too much variance to
  calibrate pricing).
- The Insights page (built) needs to feel genuinely valuable in the free
  tier — otherwise there's nothing to upsell.

**Technical work required.**

| Area | Work |
|---|---|
| Schema | Add `User.subscriptionTier` (enum: `FREE` \| `PLUS`), `User.subscriptionStatus` (`active` \| `past_due` \| `canceled` \| `trialing`), `User.stripeCustomerId`, `User.subscriptionExpiresAt`, `User.subscriptionRenewsAt`. |
| Stripe integration | Use Stripe Checkout (hosted) for the initial flow — minimal PCI surface, fastest to ship. Stripe Customer Portal handles cancellations, payment-method updates, and receipts. |
| Webhook handler | `POST /api/webhooks/stripe` — handle `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Verify webhook signatures. |
| Server-side feature gates | `middleware/requirePlus.ts` for endpoints; a `getUserTier(userId)` helper for inline checks. Insights endpoint accepts `?range=all` only for `PLUS`. |
| Frontend paywall | New component `<PaywallUpsell />` shown when a free user hits a gated feature. New `/upgrade` and `/account/subscription` routes. |
| Pricing page | `/pricing` route with the plan table. |
| Trial logic | 14-day trial without credit card → converts to paid only if user upgrades. Cheaper conversion than free→paid cold. |
| Email | Receipt sent by Stripe; we send "trial ending in 2 days" via Resend. |

**Privacy implications.** Minimal — we store Stripe customer IDs only;
Stripe handles cards / billing addresses. PCI scope is **A** (the
lowest) when using Stripe Checkout. Privacy Policy needs an
update describing the Stripe relationship.

**Legal.** Terms of Service must cover auto-renewal, refund policy, and
trial-to-paid conversion clearly (FTC ROSCA in US, EU Consumer Rights
Directive in EU). The starter ToS already has placeholders here.

**Build effort.** **M** — about 1.5–2 weeks for a solid v1 if no
unexpected Stripe friction. Webhook handling + edge cases (failed
payments, refunds, prorations) are the time sinks.

**Risks.**
- Pricing wrong → low conversion. Mitigate with a price-test cohort.
- Stripe disputes / chargebacks. Low risk for digital subs but plan for
  ~1% dispute rate.
- Feature lock-in resentment if free users feel things were "taken
  away." Mitigate by only paywalling **new** features going forward; never
  remove from the free tier what's already there.

---

## Strategy 2 — Reservation affiliate commissions

**Pitch.** When a user accepts a restaurant, surface a "Reserve a table"
CTA that deep-links to OpenTable / Resy / Tock with our affiliate ID. We
earn $1–3 per seated diner. Zero new infrastructure on our end beyond
URL construction, which makes this the **lowest-friction first-revenue
path** by a wide margin.

**Unit economics.**
- OpenTable Affiliate: ~$1 per cover (US standard, last published rate).
- Resy: comparable, lower volume.
- Tock: tip-jar small; skip for v1.

Realistic conversion: maybe 5–15% of accepts → click; 10–30% of clicks →
booking. So per acceptance, ~$0.05–0.30 in expected revenue at maturity.
At 1,000 acceptances/month → ~$50–300/mo. Modest, but pure margin and
ethical (we're not taking anything away from users).

**Prerequisites.** None beyond actual users. Works from day 1.

**Technical work required.**

| Area | Work |
|---|---|
| Schema | Add `Restaurant.externalIds` (Json: `{opentable?, resy?, tock?, yelp?}`) — single flexible column rather than separate columns per provider. |
| Matching pipeline | Some restaurants will already have a `googlePlaceId`; OpenTable's API accepts Google Place IDs for matching, so a one-pass lookup can populate `externalIds.opentable`. Manual fallback for unmatched. |
| URL builder | `src/lib/reservationLinks.ts` — takes a `Restaurant` and returns `{ opentable: string \| null, resy: string \| null }`. Pure function, easy to test. |
| Frontend CTA | "Reserve a table" button on [AcceptModal](src/components/AcceptModal.jsx) and the restaurant detail modal. Hidden when no affiliate links resolve. |
| Click tracking (optional) | `POST /api/affiliate/click` logging which restaurant + which provider + which user. Useful for attribution debugging but not strictly required — providers track conversions on their end. |
| Affiliate enrollment | Sign up at: OpenTable Affiliate Program (CJ Affiliate), Resy Affiliate Network. Approval ~1–2 weeks. |

**Privacy implications.** Standard affiliate tracking is just a URL
parameter on the outbound click. No additional user data shared
beyond what we'd ship in a regular browser request to the partner.
Disclose the affiliate relationship in Privacy Policy + ToS.

**Legal.** FTC requires affiliate disclosure for US users — a small
"PickYum earns a commission when you book through these links" footer
on the AcceptModal is sufficient.

**Build effort.** **S** — 2–3 days for OpenTable; +1 day each to add
Resy and Tock. Most of the effort is the matching pipeline (linking
existing restaurants to their OpenTable IDs) rather than the URL
construction itself.

**Risks.**
- Affiliate program rejection (unlikely at small scale).
- Low match rate — small / independent restaurants often aren't on
  OpenTable. Show the CTA only when a link resolves; don't promise
  what we can't deliver.

---

## Strategy 3 — Restaurant claim & promote (freemium B2B)

**Pitch.** Restaurants claim their listing (verify ownership) for free —
edit hours, upload photos, respond to reviews. Pay $30–50/mo to be
"Featured" in the nearby-search results, get an analytics dashboard
showing how often they appeared in selection lists, or unlock sponsored
placements (Strategy 4). This is how Yelp built its early revenue; the
data we already have (restaurant catalog from Google Places, decision
history) gives us a competitive starting position.

**Unit economics.**
- ~3–5% of claimed listings convert to paid Featured.
- ARPA $30–50/mo per paying restaurant.
- 50 paying restaurants × $40/mo = $2,000/mo.
- 500 paying × $40 = $20,000/mo.

The big lever is restaurant density: a metro with 200 active restaurants
and 1,000 users is far more sellable than a metro with 50 / 500.

**Prerequisites.**
- ~500 DAU per metro area, with ~20+ restaurants showing meaningful
  selection-list / decision activity. Below that, individual restaurant
  numbers are too thin to be sellable.
- Strategy 1 (Stripe) live — we reuse the billing infrastructure.

**Technical work required.**

| Area | Work |
|---|---|
| Schema — Restaurant ownership | New `RestaurantClaim` model: `restaurantId`, `claimedByEmail`, `claimedAt`, `verificationToken`, `verifiedAt`, `status` (`pending` \| `verified` \| `rejected`). |
| Schema — Restaurant accounts | New `RestaurantAccount` model with email/password auth (separate from `User`); links to one or more `Restaurant` rows. |
| Verification flow | Email-based verification (we have Resend wired in). Phone verification as fallback. Manual review queue for disputed claims. |
| Restaurant dashboard | Whole new SPA section under `/restaurant-portal/*` — separate auth flow, separate nav. Shows the restaurant's listing data, decision-history aggregates ("you appeared in 47 selection lists this month"), competitive set, hours/photo editor. |
| Public-facing changes | "Claimed" badge on restaurant detail; restaurant-edited hours/photos override Google Places data. |
| Featured placement | A boolean `Restaurant.featuredUntil DateTime?` that nearby/search endpoints sort on. Simple to start; can evolve into a bidding system later. |
| Billing | Stripe subscription per restaurant, monthly recurring. Reuses Strategy 1 webhook handler with a different product ID. |
| Email | New transactional templates: "your claim is verified", "your subscription renews soon", "your listing was viewed N times this week" digest. |
| Moderation | Some abuse vector: people claiming restaurants they don't own. Manual review for first N claims; automated for established patterns later. |

**Schema sketch (preview)**

```prisma
model RestaurantAccount {
  id           Int      @id @default(autoincrement())
  email        String   @unique
  passwordHash String?
  createdAt    DateTime @default(now())
  claims       RestaurantClaim[]
  stripeCustomerId String?
  subscriptionStatus String?
}

model RestaurantClaim {
  id           Int      @id @default(autoincrement())
  restaurantId Int
  ownerId      Int
  status       String   // 'pending' | 'verified' | 'rejected'
  verifiedAt   DateTime?
  rejectedReason String?
  restaurant   Restaurant @relation(fields: [restaurantId], references: [id])
  owner        RestaurantAccount @relation(fields: [ownerId], references: [id])

  @@unique([restaurantId, ownerId])
}
```

**Privacy implications.** Restaurant owners only see **aggregated**
statistics (counts, percentages) — never per-user data. The Privacy
Policy must explicitly allow this kind of aggregation; the current
starter version does, but tighten the language when this ships.

**Legal.** Restaurant Terms of Service is a separate document from user
ToS. Cover: ownership representation (the person claiming the listing
attests they have authority), payment terms, data-use scope (what
restaurants can do with the analytics we provide), termination.

**Build effort.** **L** — 6–8 weeks for a solid v1. The restaurant-side
SPA, claim/verification flow, and dashboard are each substantial pieces.

**Risks.**
- Claim disputes (Restaurant X is claimed by two parties).
- Restaurants gaming their own data (encouraging staff to add the
  listing to selections to inflate numbers). Detection: track unique
  device fingerprints / IP ranges.
- Negative review pressure — restaurants paying us may expect us to
  hide bad reviews. Hold the line: pay for *placement* and *analytics*,
  never to suppress legitimate user content.

---

## Strategy 4 — Sponsored placements

**Pitch.** Paid candidate slots in the nearby search list, the "Choose"
page suggestion bar, and as auto-included candidates in group voting
events. Always clearly labeled "Sponsored." Restaurants pay CPM
(impressions) or CPA (clicks / accepts).

**Unit economics.**
- CPM $5–15 per 1,000 ad impressions, OR
- CPA $1–3 per click, OR
- CPA $5–15 per resulting acceptance (most valuable, hardest to attribute).

At 1,000 DAU with 10 ad impressions per session, that's 300k
impressions/mo → $1,500–4,500/mo at $5–15 CPM.

**Prerequisites.**
- Strategy 3 (restaurant accounts) — we need someone to bill.
- ~1,000 DAU per metro — below that, inventory is too thin to charge
  reasonable rates.

**Technical work required.**

| Area | Work |
|---|---|
| Schema — campaigns | `AdCampaign` (`restaurantId`, `budgetCents`, `cpmCents` or `cpcCents`, `targetingJson`, `startsAt`, `endsAt`, `pacedDaily`). |
| Schema — events | `AdImpression` and `AdClick` (append-only logs for billing). |
| Targeting engine | Match queries by cuisine, geography (radius around an address), time-of-day. Start with simple AND filters; ML later if it ever justifies the cost. |
| Frequency capping | Same campaign shown ≤ N times per user per day. |
| Budget pacing | Don't blow the whole monthly budget in 3 days. |
| Tracking | `POST /api/ads/impression` (debounced) and `POST /api/ads/click`. |
| "Sponsored" labeling | Visible badge on every paid placement, color-distinct from organic. FTC compliance + user trust both depend on this. |
| Billing reconciliation | Daily/weekly job that totals impressions × CPM (or clicks × CPC) → Stripe invoice. |

**Privacy implications.** Need to be transparent: "PickYum may show
sponsored placements when restaurants pay to appear. These are always
clearly labeled." Don't use individual user behavioral data for ad
targeting beyond cuisine + general location — that crosses the line.

**Legal.** FTC-style "Sponsored" labels on every paid placement,
non-negotiable. EU users may have additional cookie-consent implications
if we add behavioral ad targeting (we shouldn't).

**Build effort.** **M** — 2–3 weeks if Strategy 3 already provides the
restaurant accounts and Stripe billing. Most effort is in the targeting
engine and the billing reconciliation logic.

**Risks.**
- Sponsored placements feel intrusive → user attrition. Mitigate by
  capping at 1 sponsored slot per 5 organic; user can hide a campaign.
- Click fraud (restaurants generating fake clicks on their own ads).
  Same fingerprint/IP detection as Strategy 3 abuse.

---

## Strategy 5 — Group event extras

**Pitch.** Premium tier for group voting: large groups (20+ voters),
custom branding (event banner image, color theme), RSVP / headcount
tracking, calendar integration enhancements, and optional integrations
with catering platforms. Pay per event ($50–200), not subscription.

**Unit economics.** Niche but high-margin. A corporate offsite or
wedding rehearsal pays gladly for $100 of polish; consumer Plus
subscribers may already get most of this free.

**Prerequisites.** The group voting feature (built) and some signal that
larger / more formal groups are actually using it. Watch for groups
with > 10 members or events scheduled > 2 weeks in advance — those are
the segment.

**Technical work required.**

| Area | Work |
|---|---|
| Schema | `Group.tier` (`FREE` / `PRO` / `EVENT`); `GroupEvent.brandingJson` (`{ bannerUrl, accentColor }`); `GroupEvent.maxAttendees`. |
| Branding upload | Supabase Storage for the banner image — already configured for OAuth, just add a bucket. |
| RSVP | New `GroupEventRsvp` model: `eventId`, `userId` or `guestEmail`, `status` (`yes` / `no` / `maybe`). |
| One-off billing | Stripe one-time payment intent rather than subscription. |
| UI surfaces | Event creation wizard with branded preview; RSVP page for event guests. |

**Privacy implications.** Standard. RSVPs by guest email need
clear-purpose use (this event only, not added to marketing list).

**Build effort.** **M** — 2–3 weeks.

**Risks.**
- Low demand if the consumer Plus tier covers most of what people want
  for normal-sized groups. Validate before building.

---

## Strategy 6 — what we're explicitly NOT doing

For posterity, in case anyone (including future me) is tempted:

**Selling user behavioral data to third parties (data broker model).**
- Privacy / legal exposure: GDPR + CCPA + state-level privacy laws
  (Texas, Virginia, Colorado, etc.) all treat behavioral data sales as
  a high-friction activity requiring explicit user consent, opt-out
  mechanisms, and disclosure.
- Trust cost: even if legal, the moment users find out (and they will,
  via press or app store reviews), the trust hit is permanent. See
  every news cycle since 2018.
- Quality problem: third-party data buyers (advertisers, analytics
  firms) generally don't trust small-platform aggregates anyway. The
  buyers are mostly looking for scale we don't have.
- Better alternative: the *same data* feeds restaurant-facing analytics
  (Strategy 3) in a way that's user-aligned. Sell access to a dashboard,
  not a CSV.

**Hidden affiliate links / unlabeled sponsored content.** FTC issue,
user-trust issue, easy to detect. Always label.

**Mid-trial pricing shifts / dark-pattern cancellation.** Bad short
term, terrible long-term. Use Stripe Customer Portal so cancellation
is one click.

**Selling raw email lists to restaurants.** Even with "consent" wrapped
into ToS, this destroys trust the moment a user gets spam.

**Auto-enroll into paid features.** Trial expiration converts to paid
only with explicit credit card capture upfront, or with an unmissable
in-app prompt.

---

## Decisions that pay off later

Things to build into the codebase *now* even if no monetization is
imminent, so we're not paying technical-debt interest later:

| Decision | Status | Why it matters later |
|---|---|---|
| `Restaurant.googlePlaceId` as canonical external pivot | ✅ Have it | Enables Strategy 2 matching (OpenTable / Resy by Place ID). |
| `UserAccepted.selectionsSnapshot` (Json) | ✅ Have it | Restaurant analytics in Strategy 3 are inverse aggregates of this data. |
| `UserAccepted.chooseMethod` | ✅ Have it | Enables segmentation in Insights and in restaurant-facing metrics. |
| Flexible Json column for external IDs | ❌ Need to add | Adding individual columns (`opentableId`, `resyId`, `tockId`) is fine for 3 partners; with more, a single `externalIds Json` is cleaner. |
| Click/impression event table | ❌ Need to add | Generic `Event` table (`type`, `userId?`, `entityId`, `props Json`, `createdAt`) covers affiliate clicks, ad impressions, and future analytics needs. |
| Cookie consent banner | ❌ Need to add | Required for EU users when we add behavioral analytics or ads. Build it before we need it, not after a complaint. |
| Restaurant-side auth model | ❌ Need to add | Big upfront cost; design it before Strategy 3 to avoid retrofitting. |

---

## Recommended sequencing

| Stage | Trigger | Build | Effort | Expected revenue |
|---|---|---|---|---|
| 1 | Now | Decision Insights (DONE) | — | $0 (foundation) |
| 2 | Any paying use | Affiliate booking links (Strategy 2) | S (~3 days) | $0.05–$0.30 per acceptance |
| 3 | ~200 DAU | PickYum Plus subscription (Strategy 1) | M (~2 wks) | $2–5/mo per paid sub at 3–5% conversion |
| 4 | ~500 DAU per metro | Restaurant claim & promote (Strategy 3) | L (~6–8 wks) | $30–50/mo per paying restaurant |
| 5 | ~1,000 DAU per metro | Sponsored placements (Strategy 4) | M (~3 wks) | $5–15 CPM |
| 6 | Opportunistic | Group event extras (Strategy 5) | M (~2–3 wks) | $50–200/event |

Numbers above are rough order-of-magnitude. The sequence is more
important than the milestones — each strategy reuses infrastructure
from the previous one (Stripe from 1, restaurant accounts from 3),
so building out of order costs significantly more.

---

## Open questions to revisit

- **Which metro do we focus on first?** Restaurant claim & promote (Strategy 3) is geographically gated — picking the right first metro matters. Probably wherever the founder lives.
- **Multi-location chains.** Does the Cheesecake Factory in Seattle have its own listing or roll up to a corporate parent? Affects matching pipeline and pricing model.
- **Are group events a separate product?** If Strategy 5 takes off, it may justify a separate product surface (a "PickYum for Events" microsite) rather than buried inside the main app.
- **International expansion.** OpenTable is US/UK/Canada; Resy is mostly US; SevenRooms is global. Affects affiliate strategy when expanding.
- **Restaurant pricing tier shape.** Single Featured tier? Or Featured / Premium / Enterprise with escalating analytics depth? Probably single tier at v1.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-05-13 | Initial doc. Captures Q1 (Insights) shipped + roadmap for Strategies 1–6. | — |
