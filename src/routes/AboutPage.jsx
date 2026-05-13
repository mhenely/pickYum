import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';

const Step = ({ number, title, children }) => (
  <div className="flex gap-4">
    <div className="shrink-0 w-7 h-7 rounded-full bg-orange-500 text-white text-sm font-bold flex items-center justify-center mt-0.5">
      {number}
    </div>
    <div>
      <p className="font-semibold text-gray-800 text-sm">{title}</p>
      <p className="text-sm text-gray-600 mt-0.5 leading-relaxed">{children}</p>
    </div>
  </div>
);

const Chip = ({ children, color = 'indigo' }) => {
  const styles = {
    indigo: 'bg-orange-100 text-orange-700',
    green:  'bg-green-100 text-green-700',
    amber:  'bg-amber-100 text-amber-700',
    gray:   'bg-gray-100 text-gray-600',
    red:    'bg-red-100 text-red-600',
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${styles[color]}`}>
      {children}
    </span>
  );
};

const AccordionItem = ({ title, emoji, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left bg-white hover:bg-gray-50 transition-colors"
      >
        <span className="flex items-center gap-2.5 font-semibold text-gray-900">
          {emoji && <span className="text-lg">{emoji}</span>}
          {title}
        </span>
        <span className={`text-gray-400 text-sm transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>
          ▼
        </span>
      </button>
      {open && (
        <div className="px-5 pb-5 pt-1 border-t border-gray-100 bg-white">
          {children}
        </div>
      )}
    </div>
  );
};

const AboutPage = () => {
  const userId = useSelector((state) => state.userInfo?.users?.[0]?.id);

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">

      {/* Hero */}
      <div className="text-center mb-10">
        <h1 className="text-4xl font-extrabold text-gray-900 tracking-tight">
          Welcome to <span className="text-orange-600">pickYum</span>
        </h1>
        <p className="mt-3 text-lg text-gray-600 max-w-xl mx-auto">
          Can't decide where to eat? pickYum flips a coin, spins a wheel, and keeps track of every restaurant you've ever chosen.
        </p>
      </div>

      <div className="flex flex-col gap-3">

        <AccordionItem title="Getting Started" emoji="🚀" defaultOpen>
          <div className="flex flex-col gap-3 mt-3">
            <p className="text-sm text-gray-600 leading-relaxed">
              pickYum requires an account so your selections, favorites, and history stay with you. Sign up with email or log in instantly with Google.
            </p>
            <Step number="1" title="Create an account or log in">
              Head to the <Link to="/authentication" className="text-orange-600 hover:underline font-medium">Sign In page</Link> and enter your email and password, or click <strong>Continue with Google</strong>.
            </Step>
            <Step number="2" title="Add restaurants to your Selections">
              Selections are the pool of restaurants for tonight. Add them from the <strong>Search</strong>, <strong>Compare</strong>, or <strong>Choose</strong> page — anywhere you see <Chip>Add to Selections</Chip>.
            </Step>
            <Step number="3" title="Let the app decide">
              Go to <strong>Choose</strong> and flip a coin or spin the roulette. Accept the winner — it's logged to your history automatically.
            </Step>
          </div>
        </AccordionItem>

        <AccordionItem title="Coin Flip & Roulette" emoji="🪙">
          <div className="flex flex-col gap-4 mt-3">
            <div className="rounded-lg border border-yellow-100 bg-yellow-50 p-4">
              <p className="font-semibold text-gray-800 text-sm mb-2">🪙 Coin Flip Mode</p>
              <ol className="flex flex-col gap-2.5">
                <Step number="1" title="Assign Heads and Tails">
                  Tap the <Chip color="amber">H</Chip> or <Chip>T</Chip> buttons on any selection card, or drag the tokens onto a card.
                </Step>
                <Step number="2" title="Flip the coin">
                  Click <strong>Choose My Fate</strong>. The coin spins and lands on Heads or Tails.
                </Step>
                <Step number="3" title="Accept or remove the winner">
                  Click <Chip color="green">Accept</Chip> to log it and remove from selections, or <Chip color="red">Remove</Chip> to drop it without logging.
                </Step>
              </ol>
            </div>
            <div className="rounded-lg border border-amber-100 bg-amber-50 p-4">
              <p className="font-semibold text-gray-800 text-sm mb-2">🎰 Roulette Mode</p>
              <p className="text-sm text-gray-600 mb-2">Switch to roulette when you have more than two options. Click <strong>Switch to Roulette</strong> in the left sidebar.</p>
              <ul className="text-sm text-gray-600 space-y-1.5 list-disc list-inside">
                <li>All current selections appear as wheel slices (requires at least 2).</li>
                <li>Click <strong>Choose My Fate</strong> to spin. The wheel slows and highlights the winner.</li>
                <li>Use <strong>🎲 Surprise Me</strong> to skip the flip and jump straight to the acceptance screen.</li>
              </ul>
            </div>
            <div className="rounded-lg bg-orange-50 border border-orange-100 px-4 py-3">
              <p className="text-sm text-orange-800">
                <strong>Tip:</strong> Use <strong>⚙ Filters</strong> to narrow the flip pool by price, cuisine, or "open now" — without removing restaurants from your selections.
              </p>
            </div>
          </div>
        </AccordionItem>

        <AccordionItem title="Selections & Favorites" emoji="⭐">
          <div className="flex flex-col gap-4 mt-3">
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-1.5">Selections</p>
              <ul className="text-sm text-gray-600 space-y-1.5 list-disc list-inside">
                <li>Selections appear in the header bar on Search, Compare, and Choose pages.</li>
                <li>Remove one by clicking <strong>✕</strong> next to its name in the bar or the Selections dropdown.</li>
                <li>Can't find your restaurant? Type a custom name on the Choose page to add it instantly.</li>
              </ul>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-1.5">Favorites</p>
              <ul className="text-sm text-gray-600 space-y-1.5 list-disc list-inside">
                <li>Click the <span className="text-red-500">♥</span> heart icon on any card to toggle favorite status.</li>
                <li>Favorites appear in the left sidebar on Choose and Compare for one-click adding.</li>
                <li>Unfavoriting never deletes history — it just removes the shortcut.</li>
              </ul>
            </div>
          </div>
        </AccordionItem>

        <AccordionItem title="Compare Page" emoji="⚖️">
          <p className="text-sm text-gray-600 mt-3 leading-relaxed mb-3">
            Evaluate up to <strong>4 restaurants at once</strong> before handing it off to the coin.
          </p>
          <ul className="text-sm text-gray-600 space-y-2 list-disc list-inside">
            <li>Click any restaurant card in the Favorites or Selections sidebars to open its detail panel.</li>
            <li>Keep clicking to add more panels side-by-side (up to 4). Click a panel's <strong>✕</strong> to close it.</li>
            <li>Each panel shows cuisine, price, hours, phone, website, Yelp, takeout/delivery, and ratings.</li>
            <li>Use <Chip>Add to Selections</Chip> and <Chip color="red">♥ Favorite</Chip> without leaving the page.</li>
          </ul>
        </AccordionItem>

        <AccordionItem title="History & Reviews" emoji="📋">
          <div className="flex flex-col gap-3 mt-3">
            <p className="text-sm text-gray-600 leading-relaxed">
              Any restaurant you <strong>accept</strong> or <strong>review</strong> appears on your History page.
            </p>
            <Step number="1" title="Browse your history">
              Sort by <Chip color="gray">Date</Chip> or <Chip color="gray">Times Chosen</Chip>. Filter to favorites-only with the <Chip color="red">♥ Favorites</Chip> toggle.
            </Step>
            <Step number="2" title="Add a review">
              Click <strong>Add Review</strong> on any card, or open the detail modal with the restaurant name link. You can also write reviews directly inside the detail modal on any page.
            </Step>
            <Step number="3" title="Archive restaurants">
              Use <Chip color="gray">Archive</Chip> to hide a restaurant without deleting it. Toggle <strong>Show Archives</strong> to restore.
            </Step>
            <Step number="4" title="Notes">
              Open a restaurant's detail modal and use <strong>Your Note</strong> to jot down parking tips, must-order dishes, etc. Notes appear on your history cards as a preview.
            </Step>
          </div>
        </AccordionItem>

        <AccordionItem title="Groups & Group Voting" emoji="👥">
          <div className="flex flex-col gap-3 mt-3">
            <p className="text-sm text-gray-600 leading-relaxed">
              Groups let you coordinate restaurant decisions with friends. Find them under the <strong>Groups</strong> nav link (requires sign-in).
            </p>
            <Step number="1" title="Create or join a group">
              Create a group and invite friends by username. They'll see a notification badge on the Groups link.
            </Step>
            <Step number="2" title="Build the restaurant pool">
              Any member can add restaurants to the group's pool. The host can remove them.
            </Step>
            <Step number="3" title="Start voting">
              The host clicks <strong>Start voting now</strong>. This locks the pool and opens a live session — members get a notification and can join via the session code (e.g. <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">TACO-472</code>).
            </Step>
            <Step number="4" title="Vote and tally">
              Each member approves the restaurants they'd be happy with. The host closes voting and the highest-approved restaurant wins. Ties are broken by coin flip or roulette.
            </Step>
          </div>
        </AccordionItem>

        <AccordionItem title="Ratings" emoji="★">
          <div className="flex flex-col gap-3 mt-3">
            <p className="text-sm text-gray-600">Restaurant cards show two types of ratings:</p>
            <div className="flex flex-col gap-2">
              <div className="flex items-start gap-3 text-sm">
                <Chip color="green">G ★ 4.2</Chip>
                <span className="text-gray-600">Google rating from the restaurant's Maps listing.</span>
              </div>
              <div className="flex items-start gap-3 text-sm">
                <Chip color="indigo">You ★ 4.5</Chip>
                <span className="text-gray-600">Your personal average, calculated from all your reviews for that restaurant.</span>
              </div>
              <div className="flex items-start gap-3 text-sm">
                <Chip color="amber">C ★ 4.3</Chip>
                <span className="text-gray-600">Community average across all users' reviews.</span>
              </div>
            </div>
          </div>
        </AccordionItem>

        <AccordionItem title="Tips & Shortcuts" emoji="💡">
          <ul className="text-sm text-gray-600 space-y-2.5 list-disc list-inside mt-3">
            <li>The <strong>Selections dropdown</strong> in the navbar lets you peek at your lineup and remove restaurants from any page.</li>
            <li>On the Choose page, type in the search box to find and add any restaurant — or add a custom name on the fly.</li>
            <li>Use <strong>🎲 Surprise Me</strong> to skip straight to a random pick without flipping or spinning.</li>
            <li>Your Google profile photo appears in the navbar. Without Google login, a generic avatar shows instead.</li>
            <li>The coin flip and roulette each count toward your <strong>Total Flips & Spins</strong> stat on Your Info.</li>
            <li>Scheduled group voting auto-launches at the set time, even if no one is on the page.</li>
          </ul>
        </AccordionItem>

      </div>

      {/* CTA */}
      <div className="mt-10 rounded-2xl bg-orange-500 px-8 py-8 text-center">
        <p className="text-white font-bold text-xl mb-2">Ready to eat?</p>
        <p className="text-orange-100 text-sm mb-5">
          Add some restaurants to your selections and let the coin decide.
        </p>
        <Link
          to={userId ? `/choose/${userId}` : '/authentication'}
          className="inline-block rounded-lg bg-white text-orange-600 font-semibold px-6 py-2.5 text-sm hover:bg-orange-50 transition-colors shadow"
        >
          {userId ? 'Go to Choose →' : 'Sign In to Get Started →'}
        </Link>
      </div>
    </div>
  );
};

export default AboutPage;
