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

import { Link } from 'react-router-dom';
import Button from '../components/ui/Button';

function PillarCard({ icon, title, body }) {
  return (
    <div className="rounded-xl border border-orange-100 bg-white px-5 py-6 shadow-sm hover:shadow-md transition-shadow">
      <div className="text-3xl mb-3" aria-hidden="true">{icon}</div>
      <h3 className="text-base font-bold text-gray-900 mb-1">{title}</h3>
      <p className="text-sm text-gray-600 leading-relaxed">{body}</p>
    </div>
  );
}

function Step({ number, title, body }) {
  return (
    <div className="flex gap-4">
      <div className="shrink-0 h-9 w-9 rounded-full bg-gradient-to-br from-orange-500 to-red-500 text-white font-bold text-sm flex items-center justify-center shadow-brand-sm">
        {number}
      </div>
      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-0.5">{title}</h4>
        <p className="text-sm text-gray-600 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

export default function LandingPage() {
  // No wrapper min-h-screen — App's <main> already grows to fill
  // remaining height and Navigation supplies the Footer below.
  return (
    <>

      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="relative bg-gradient-to-br from-orange-500 via-orange-500 to-red-500 px-4 py-16 sm:py-24 overflow-hidden">
        {/* Subtle radial decoration so the hero doesn't read as a flat
            slab. Positioned + opacity-tuned to feel like a glow rather
            than a graphic; aria-hidden because it's pure visual. */}
        <div className="absolute inset-0 opacity-20 pointer-events-none" aria-hidden="true">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full bg-yellow-300 blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full bg-red-400 blur-3xl" />
        </div>

        <div className="relative mx-auto max-w-3xl text-center">
          <div className="text-5xl mb-5" aria-hidden="true">🍽️</div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight mb-4">
            Can't decide where to eat?
          </h1>
          <p className="text-lg sm:text-xl text-orange-50 max-w-xl mx-auto mb-8 leading-relaxed">
            pickYum saves your favorite spots, then picks one for you with a
            coin flip, a wheel spin, or a group vote.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
            <Link
              to="/authentication"
              className="rounded-lg bg-white text-orange-600 px-6 py-3 text-sm font-bold shadow-lg hover:bg-orange-50 transition-colors"
            >
              Get started — it's free
            </Link>
            <Link
              to="/authentication"
              className="rounded-lg border-2 border-white/40 text-white px-6 py-3 text-sm font-semibold hover:bg-white/10 transition-colors"
            >
              Sign in
            </Link>
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
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <PillarCard
              icon="🔍"
              title="Discover"
              body="Search nearby spots from live Google data or build a personal list of favorites you keep coming back to."
            />
            <PillarCard
              icon="🪙"
              title="Decide instantly"
              body="Coin flip, roulette wheel, or surprise me — every mode pulls from your active options and tracks the result."
            />
            <PillarCard
              icon="👥"
              title="Vote together"
              body="Group sessions let friends vote on tonight's pick — or plan a whole trip with per-meal voting. Guests join via link, no account needed."
            />
          </div>
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────── */}
      <section className="bg-white px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 text-center mb-3">
            Three steps and you're done
          </h2>
          <p className="text-base text-gray-600 text-center mb-10">
            Most users save a few favorites once, then come back any time they need to decide.
          </p>
          <div className="flex flex-col gap-6">
            <Step
              number="1"
              title="Save the restaurants you'd actually go to"
              body="Heart spots from a nearby search, type in your own, or pull from a friend's recommendations."
            />
            <Step
              number="2"
              title="Add a few to your Options"
              body="Tonight's contenders. Filter by cuisine or price; toggle which ones are in the flip pool."
            />
            <Step
              number="3"
              title="Let pickYum decide"
              body="Flip a coin, spin the wheel, surprise-pick, or invite a group to vote. Accept the result to log it for next time."
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
