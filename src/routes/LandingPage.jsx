// Public marketing landing page. Shown at `/` to unauthenticated
// visitors — replaces the previous "drop you straight into the search
// form" UX, which was useless for first-time visitors who had no idea
// what the product did. Authenticated users still get SearchPage at
// `/` (HomePage dispatches based on auth status).
//
// Design intent:
//   1. Hero strip carries the brand visually — same gradient as the
//      group-invite hero, so links from a friend's invite land on a
//      visually-consistent product.
//   2. Three concrete value pillars (Discover / Decide / Vote
//      together) rather than vague marketing copy. Each maps to a
//      real surface inside the app.
//   3. "How it works" is the proof — three numbered steps a user can
//      mentally validate ("yes, I can imagine doing those").
//   4. CTAs always point to /authentication. The page never sells
//      anything more than "make an account."

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MagnifyingGlassIcon, SparklesIcon, UserGroupIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import Button from '../components/ui/Button';
import LandingCoinFlipDemo from '../components/LandingCoinFlipDemo';

// Card-with-icon used by the value-pillars section. `icon` is a Heroicons
// component (constructor, not an instance) so the card can size it
// consistently with its container. Emoji here would clash with the
// in-app icon system we just standardized on Heroicons for navigation —
// the landing page is the user's first impression and is the place we
// want to feel most "real product, less toy."
//
// `detail` is the optional expandable body — used to fold the old
// "How it works" steps into the corresponding pillar so the page
// doesn't read as two parallel feature lists.
function PillarCard({ Icon, title, body, detail }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-orange-100 bg-white px-5 py-6 shadow-sm hover:shadow-md transition-shadow flex flex-col">
      <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-orange-100 to-orange-50 text-orange-600">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <h3 className="text-base font-bold text-gray-900 mb-1">{title}</h3>
      <p className="text-sm text-gray-600 leading-relaxed">{body}</p>
      {detail && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-orange-600 hover:text-orange-700 self-start"
          >
            {open ? 'Hide' : 'How it works'}
            <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          {open && (
            <div className="mt-3 pt-3 border-t border-orange-100 text-sm text-gray-600 leading-relaxed animate-[fadeIn_200ms_ease-out]">
              {detail}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function LandingPage() {
  // "Try as a guest" sets a localStorage flag and forces a full-page
  // load of `/`. We can't use react-router's navigate('/') here because
  // LandingPage IS at `/` — navigate sees no path change, doesn't
  // re-render HomePage, and the just-written localStorage flag never
  // gets re-read. A full reload re-runs HomePage from scratch, which
  // checks the flag inline and routes to SearchPage in guest mode.
  const handleTryAsGuest = () => {
    try { localStorage.setItem('pickyum_skip_landing', '1'); } catch { /* ignore */ }
    window.location.assign('/');
  };

  // No wrapper min-h-screen — App's <main> already grows to fill
  // remaining height and Navigation supplies the Footer below.
  return (
    <>

      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="relative bg-gradient-to-br from-orange-500 via-orange-500 to-red-500 px-4 py-12 sm:py-20 overflow-hidden">
        {/* Subtle radial decoration so the hero doesn't read as a flat
            slab. Positioned + opacity-tuned to feel like a glow rather
            than a graphic; aria-hidden because it's pure visual. */}
        <div className="absolute inset-0 opacity-20 pointer-events-none" aria-hidden="true">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full bg-yellow-300 blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full bg-red-400 blur-3xl" />
        </div>

        {/* Split hero: copy + CTAs left, interactive coin-flip demo right.
            On mobile the demo stacks below the copy (text-first so the
            value prop loads above the fold). The demo is the highest-
            leverage element on the page — it's the only "screenshot"
            we can ship without design assets, and it lets visitors
            experience the core delight before signing up. */}
        <div className="relative mx-auto max-w-6xl grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
          <div className="text-center lg:text-left">
            <div className="text-5xl mb-5 lg:mx-0 mx-auto" aria-hidden="true">🍽️</div>
            <h1 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight mb-4">
              Can't decide where to eat?
            </h1>
            <p className="text-lg sm:text-xl text-orange-50 max-w-xl mx-auto lg:mx-0 mb-8 leading-relaxed">
              pickYum saves your favorite spots, then picks one for you with a
              coin flip, a wheel spin, or a group vote.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center lg:justify-start items-center">
              <Link
                to="/authentication"
                className="rounded-lg bg-white text-orange-600 px-6 py-3 text-sm font-bold shadow-lg hover:bg-orange-50 transition-colors"
              >
                Get started — it's free
              </Link>
              <button
                type="button"
                onClick={handleTryAsGuest}
                className="rounded-lg border-2 border-white/40 text-white px-6 py-3 text-sm font-semibold hover:bg-white/10 transition-colors"
              >
                Try as a guest →
              </button>
            </div>
            <p className="mt-3 text-xs text-orange-100/80 text-center lg:text-left">
              No credit card. Guest mode keeps everything local until you sign up.
            </p>
          </div>

          {/* Demo column — order-first on mobile would push CTAs below
              the fold; order-last keeps the textual value prop on top
              while letting the visual anchor still sit prominent. */}
          <div className="order-last lg:order-none">
            <LandingCoinFlipDemo />
          </div>
        </div>
      </section>

      {/* ── Three value pillars ──────────────────────────────── */}
      <section className="bg-orange-50/50 px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 text-center mb-3">
            Built for the "I don't know, you pick" moment
          </h2>
          <p className="text-base text-gray-600 text-center mb-10 max-w-xl mx-auto">
            Stop debating. Stop falling back to the same three places.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 items-start">
            <PillarCard
              Icon={MagnifyingGlassIcon}
              title="Discover"
              body="Search nearby spots from live Google data or build a personal list of favorites you keep coming back to."
              detail="Heart a place from a nearby search to save it, type in your own custom spot, or pull from a friend's shared recommendations. Your favorites stay one tap away forever."
            />
            <PillarCard
              Icon={SparklesIcon}
              title="Decide instantly"
              body="Coin flip or roulette wheel — every mode pulls from your active options and tracks the result."
              detail="Add a few candidates to your Options bar (filter by cuisine or price), then pick a decision mode. Accept the result and pickYum logs it for next time's insights."
            />
            <PillarCard
              Icon={UserGroupIcon}
              title="Vote together"
              body="Group sessions let friends vote on tonight's pick — or plan a whole trip with per-meal voting."
              detail="Spin up a one-off vote in seconds (guests join via a link, no account needed) or build a multi-day trip with breakfast/brunch/lunch/dinner slots that everyone votes on as you go."
            />
          </div>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────── */}
      <section className="bg-gradient-to-br from-orange-500 to-red-500 px-4 py-16 text-center">
        <div className="mx-auto max-w-xl">
          <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">
            Ready to stop debating?
          </h2>
          <p className="text-orange-50 mb-7">
            Create an account in under a minute. Free, no card required.
          </p>
          <Link to="/authentication">
            <Button variant="secondary" size="lg" className="!bg-white !text-orange-600 !border-white hover:!bg-orange-50">
              Get started
            </Button>
          </Link>
          <p className="text-xs text-orange-100 mt-4">
            Already have an account?{' '}
            <Link to="/authentication" className="underline hover:text-white">Sign in</Link>
          </p>
        </div>
      </section>
    </>
  );
}
