import { useState, useEffect, useCallback } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import Footer from "./Footer";
import { Disclosure, DisclosureButton, DisclosurePanel, Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import { Bars3Icon, XMarkIcon, BellIcon } from '@heroicons/react/24/outline'
import { useDispatch, useSelector } from "react-redux";
import { removeUserOption } from "../redux/slices/userInfoSlice";
import { logoutUser } from "../redux/slices/authSlice";
import { pushToast } from "../redux/slices/toastSlice";
import useCurrentUser from "../hooks/useCurrentUser";
import RestaurantDetailModal from "./RestaurantDetailModal";
import { socialApi } from "../lib/socialApi";
import { groupsApi } from "../lib/groupsApi";
import { api } from "../lib/api";

// Renders the user's uploaded avatar when present, falling back to the
// gradient + generic-person SVG otherwise. The wrapper keeps the same
// 32×32 footprint either way so the navbar layout never shifts when a
// user uploads or removes a picture.
const GenericAvatar = ({ src }) => (
  <div className="h-8 w-8 rounded-full overflow-hidden bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center shadow-brand-sm">
    {src ? (
      <img src={src} alt="" className="h-full w-full object-cover" />
    ) : (
      <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
      </svg>
    )}
  </div>
);

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

// Shallow id-list compare used by the notification poll. Returns true when
// two arrays carry the same items in the same order (compared by id
// extractor) — letting the poll bail out of setState when the result hasn't
// changed, avoiding the full navbar + chip-strip re-render every 60s.
function sameIds(a, b, getId) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (getId(a[i]) !== getId(b[i])) return false;
  }
  return true;
}

// Top-of-app banner asking unverified users to confirm their email. Tries
// /api/auth/resend-verification on demand; the server rate-limits resends
// so spam-clicking is harmless. Dismissal is per-session (sessionStorage)
// so the banner returns next time the user logs in — a stronger nudge than
// permanent dismissal without becoming annoying.
function EmailVerifyBanner({ email }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('pickyum:verify-banner-dismissed') === '1'; }
    catch { return false; }
  });
  const [sending,   setSending]   = useState(false);
  const [sent,      setSent]      = useState(false);
  const [error,     setError]     = useState('');

  if (dismissed) return null;

  const handleResend = async () => {
    setSending(true);
    setError('');
    try {
      await api.auth.resendVerification();
      setSent(true);
    } catch (err) {
      // The server returns 429 when rate-limited — surface a friendly hint.
      setError(err?.message ?? 'Could not send. Try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  const handleDismiss = () => {
    try { sessionStorage.setItem('pickyum:verify-banner-dismissed', '1'); }
    catch { /* private mode, etc. — non-fatal */ }
    setDismissed(true);
  };

  return (
    <div className="bg-amber-50 border-b border-amber-200">
      <div className="mx-auto max-w-7xl px-4 py-2 sm:px-6 lg:px-8 flex items-center gap-3 flex-wrap">
        <span className="text-amber-700 text-base shrink-0" aria-hidden="true">✉️</span>
        <p className="text-xs text-amber-900 flex-1 min-w-0">
          {sent
            ? <>Verification email sent{email ? <> to <span className="font-semibold">{email}</span></> : ''}. Check your inbox.</>
            : <>Verify your email address{email ? <> (<span className="font-semibold">{email}</span>)</> : ''} to unlock account-recovery features.</>
          }
          {error && <span className="ml-2 text-red-600">{error}</span>}
        </p>
        {!sent && (
          <button
            onClick={handleResend}
            disabled={sending}
            className="text-xs font-semibold text-amber-800 hover:text-amber-900 underline disabled:opacity-40 shrink-0"
          >
            {sending ? 'Sending…' : 'Resend email'}
          </button>
        )}
        <button
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="text-amber-500 hover:text-amber-700 shrink-0"
        >
          ×
        </button>
      </div>
    </div>
  );
}

const NavBar = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const [detailId, setDetailId] = useState(null);
  const currentOptions = currentUser.options;
  const userId = currentUser.id;
  const dispatch = useDispatch();
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const allRestaurants = customRestaurants;
  const isAuthenticated = useSelector((state) => state.auth.status === 'authenticated');
  // Drives the "verify your email" banner. We trust the field from auth.user
  // (populated by api.auth.me on session restore) over userInfo since it's
  // the canonical post-login signal. Defaults to true so a missing field
  // doesn't flash a stale "verify" banner mid-rehydrate.
  const isEmailVerified = useSelector((state) => state.auth.user?.emailVerified ?? true);
  const userEmail       = useSelector((state) => state.auth.user?.email ?? '');
  const userAvatar      = useSelector((state) => state.auth.user?.avatarUrl ?? null);

  // ── Notifications (friend requests + group invites + trip invites + voting alerts) ─
  const [pendingRequests, setPendingRequests] = useState([]);
  const [pendingGroupInvites, setPendingGroupInvites] = useState([]);
  const [pendingTripInvites, setPendingTripInvites] = useState([]);
  // Active group votes the user can join right now. Flattened from
  // groups.events[] — one entry per VOTING event with a live sessionId so the
  // notification link goes straight to the voting page.
  const [activeVotes, setActiveVotes] = useState([]);
  // Active trip meals where the user is in `participantUserIds` (a subset
  // explicitly picked by the host). Self-clears once the meal hits DONE or
  // the user is removed from the participant list.
  const [participantMeals, setParticipantMeals] = useState([]);

  const fetchNotifications = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      // Parallel fetch so the bell renders quickly even when one is slow.
      // Failure on any one is non-fatal — the catch outside still suppresses;
      // individual fields just stay empty until next poll.
      const [
        { requests },
        { pendingInvites, groups },
        { invites: tripInvites },
        { meals: pMeals },
      ] = await Promise.all([
        socialApi.getIncoming(),
        groupsApi.list(),
        api.trips.listMyInvites(),
        api.trips.listMyParticipantMeals(),
      ]);

      // Walk every group the user is in, surface each event currently in
      // VOTING status. (The old code filtered `groups` by a non-existent
      // `Group.status` field — voting state lives on `GroupEvent`, not Group.)
      const votes = [];
      for (const g of groups ?? []) {
        for (const ev of g.events ?? []) {
          if (ev.status === 'VOTING' && ev.sessionId) {
            votes.push({
              groupId:   g.id,
              groupName: g.name,
              eventId:   ev.id,
              eventName: ev.name,
              sessionId: ev.sessionId,
            });
          }
        }
      }

      // Equality-gated setStates. Every 60s poll used to fire four
      // unconditional setState calls — each one re-rendered the entire
      // navbar (and the options chip strip, and the bell dropdown) even
      // when the poll result was identical to the previous tick. Compare
      // by length + per-row id and bail if nothing changed.
      setPendingRequests((prev) =>
        sameIds(prev, requests, (r) => r?.id) ? prev : requests);
      setPendingGroupInvites((prev) =>
        sameIds(prev, pendingInvites, (i) => i?.id) ? prev : pendingInvites);
      setPendingTripInvites((prev) =>
        sameIds(prev, tripInvites, (i) => i?.id) ? prev : tripInvites);
      setActiveVotes((prev) =>
        sameIds(prev, votes, (v) => v?.sessionId) ? prev : votes);
      setParticipantMeals((prev) =>
        sameIds(prev, pMeals, (m) => m?.id) ? prev : pMeals);
    } catch { /* non-fatal */ }
  }, [isAuthenticated]);

  // Background poll for incoming friend requests, group invites, and live votes.
  // 60s is a compromise: tight enough to feel near-realtime for invites, loose
  // enough that two background tabs aren't generating one request/sec total.
  //
  // Polling pauses while the tab is hidden — no point burning API calls and
  // mobile battery for notifications the user can't see. When the tab
  // returns to focus, we immediately fetch once (so a user coming back to
  // pickYum after lunch sees notifications without a 60s delay) and then
  // resume the interval. visibilitychange + the conditional inside the
  // interval handler together cover both "tab goes hidden mid-poll" and
  // "tab was already hidden when we mounted".
  const NOTIFICATIONS_POLL_INTERVAL_MS = 60_000;
  useEffect(() => {
    let interval = null;

    const startPolling = () => {
      if (interval) return;
      // Fire one immediate fetch so the visible UI is fresh, then resume
      // the cadence.
      fetchNotifications();
      interval = setInterval(() => {
        if (document.hidden) return; // belt-and-braces; visibilitychange below stops it
        fetchNotifications();
      }, NOTIFICATIONS_POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) stopPolling();
      else                 startPolling();
    };

    if (!document.hidden) startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchNotifications]);

  // Real-time SSE channel for notification refreshes. The server publishes
  // `event: refresh` whenever a group/trip invite, meal-participant
  // assignment, or friend request is created targeting this user. We don't
  // get the new payload over the channel (it would have to traverse Redis
  // pub/sub between instances); instead the push triggers an immediate
  // refetch. Polling remains as a backstop — if the socket drops between
  // pushes, the next 60s tick recovers state.
  //
  // EventSource auto-reconnects on disconnect by default (~3s retry, which
  // we control via the server's `retry:` field if needed later). No tab-
  // visibility handling: browsers throttle background EventSources but
  // don't close them, and the cost of an idle SSE socket is negligible
  // compared to the wake-and-fetch we'd otherwise need.
  useEffect(() => {
    if (!isAuthenticated) return;
    const BASE = import.meta.env.VITE_API_BASE_URL ?? '';
    // withCredentials so the auth cookie rides along — the /stream
    // endpoint is gated by requireAuth.
    const es = new EventSource(`${BASE}/api/notifications/stream`, { withCredentials: true });
    es.addEventListener('refresh', (e) => {
      // The server frames carry { reason } so the client can route on
      // type without an extra round-trip. Parsing is defensive: any
      // malformed payload still falls through to a plain refetch.
      let reason = null;
      try { reason = JSON.parse(e.data)?.reason ?? null; } catch { /* ignore */ }
      fetchNotifications();
      // 'vote-result' is transient — the just-concluded vote drops off
      // the activeVotes list (it's no longer in VOTING status) and the
      // bell has no persistent "recent results" row. Surface it as a
      // toast so the user doesn't miss the outcome of a vote they were
      // part of, especially when they closed the live session tab.
      if (reason === 'vote-result') {
        dispatch(pushToast({
          id: `vote-result-${Date.now()}`,
          status: 'info',
          label: 'A vote you joined just concluded — check your groups or trips for the winner.',
        }));
      }
    });
    // No need to handle the default `message` event — the server only
    // emits typed refreshes plus heartbeat comments (which EventSource
    // ignores). errors trigger the built-in retry; we just close on
    // unmount so a re-mount opens a fresh connection.
    return () => { es.close(); };
  }, [isAuthenticated, fetchNotifications, dispatch]);

  const handleAccept = async (requestId) => {
    try {
      await socialApi.respondRequest(requestId, 'accept');
      await fetchNotifications();
    } catch { /* ignore */ }
  };

  const handleReject = async (requestId) => {
    try {
      await socialApi.respondRequest(requestId, 'reject');
      await fetchNotifications();
    } catch { /* ignore */ }
  };

  const handleGroupInviteRespond = async (invite, action) => {
    try {
      await groupsApi.respondInvite(invite.group.id, invite.id, action);
      await fetchNotifications();
    } catch { /* ignore */ }
  };

  const handleTripInviteRespond = async (invite, action) => {
    try {
      await api.trips.respondToInvite(invite.tripId, invite.id, action);
      await fetchNotifications();
    } catch { /* ignore */ }
  };

  const handleLogout = () => {
    // The auth slice + listener now wipe local user data on BOTH fulfilled
    // and rejected, so `.then()` works for the navigation regardless of API
    // outcome. The user lands on home with no residual data either way.
    dispatch(logoutUser()).then(() => navigate('/'));
  };

  const navigation = [
    { name: 'Search',   link: '/',                active: pathname === '/' },
    { name: 'Compare',  link: '/restaurant',       active: pathname.startsWith('/restaurant') },
    { name: 'Choose',   link: `/choose/${userId}`, active: pathname.startsWith('/choose') },
    { name: 'Socials',  link: '/socials',          active: pathname.startsWith('/socials') || pathname.startsWith('/groups'), authOnly: true },
    { name: 'Trips',    link: '/trips',            active: pathname.startsWith('/trips'), authOnly: true },
    { name: 'Insights', link: '/insights',         active: pathname.startsWith('/insights'), authOnly: true },
  ];

  const userNavigation = isAuthenticated
    ? [
        { name: 'Your Info',    link: `/userInfo/${userId}` },
        { name: 'Your History', link: `/History/${userId}` },
      ]
    : [];

  return (
    <>
      {/* App shell: full-viewport flex column. Nav + banners take their
          natural height, <main> grows to fill the remainder so the Footer
          anchors at the bottom of the viewport on short pages but stays
          below content (and the page scrolls) on long ones. Replaces the
          old `min-h-full` wrapper which had no effect — Footer's mt-auto
          only works inside a flex column. */}
      <div className="min-h-screen flex flex-col">
        {/* Sticky on tablet/desktop (md:+), scrolls with page on mobile.
            Vertical real estate is at a premium on phones, and the
            mobile hamburger menu already provides on-demand access to
            every nav link — sticky is most valuable on long-scroll
            desktop pages (History, Search results, Insights) where
            scrolling back to the top to switch pages is real friction.

            md:bg-white/90 + md:backdrop-blur-sm: translucent in the
            sticky variant so scrolled content shows through subtly,
            matching the modern-app feel. Default mobile keeps opaque
            bg-white since it's not sticky and there's no content
            scrolling beneath it.

            z-30 sits below the layers that need to be drawable on top
            of the nav: modals (z-50), portaled kebab popovers (z-60),
            Toaster (z-100). Above page content (no explicit z-index)
            and the celebration overlay (z-40), so the nav stays
            visible during normal scroll.

            top-0 anchors the sticky edge to the viewport top — note
            this requires no `overflow-*` on any ancestor that would
            otherwise create a new scroll container; the `min-h-screen
            flex flex-col` wrapper is sticky-friendly. */}
        <Disclosure
          as="nav"
          className="bg-white border-b border-orange-200 md:sticky md:top-0 md:z-30 md:bg-white/90 md:backdrop-blur-sm"
          style={{boxShadow: '0 1px 0 #fed7aa, 0 4px 12px rgba(234,88,12,0.06)'}}
        >
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="flex h-16 items-center justify-between">

              {/* Logo + desktop nav links */}
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Link to="/" className="flex items-center gap-2 mr-2">
                    <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-red-500 text-lg shadow-brand-sm select-none">🍽</span>
                    <span className="font-display font-extrabold text-lg tracking-tight bg-gradient-to-br from-orange-600 to-red-600 bg-clip-text text-transparent">pickYum</span>
                  </Link>
                </div>
                <div className="hidden md:block">
                  <div className="ml-10 flex items-baseline space-x-1">
                    {navigation.filter((item) => !item.authOnly || isAuthenticated).map((item) => (
                      <Link
                        key={item.name}
                        to={item.link}
                        aria-current={item.active ? 'page' : undefined}
                        className={classNames(
                          item.active
                            ? 'bg-orange-50 text-orange-600 font-semibold'
                            : 'text-stone-500 hover:bg-orange-50 hover:text-orange-600',
                          'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        )}
                      >
                        {item.name}
                        {item.name === 'Groups' && (pendingGroupInvites.length + activeVotes.length) > 0 && (
                          <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none">
                            {pendingGroupInvites.length + activeVotes.length}
                          </span>
                        )}
                        {item.name === 'Trips' && pendingTripInvites.length > 0 && (
                          <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none">
                            {pendingTripInvites.length}
                          </span>
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right side: desktop controls + mobile hamburger */}
              <div className="flex items-center gap-2">

                {/* Desktop: Options dropdown + profile */}
                <div className="hidden md:flex items-center gap-2">

                  {/* Notifications bell */}
                  {isAuthenticated && (
                    <Menu as="div" className="relative">
                      <MenuButton className="relative flex items-center rounded-md p-2 text-stone-500 hover:bg-orange-50 hover:text-orange-600 transition-colors">
                        <BellIcon className="h-5 w-5" />
                        {(pendingRequests.length + pendingGroupInvites.length + pendingTripInvites.length + activeVotes.length + participantMeals.length) > 0 && (
                          <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none">
                            {pendingRequests.length + pendingGroupInvites.length + pendingTripInvites.length + activeVotes.length + participantMeals.length}
                          </span>
                        )}
                      </MenuButton>

                      <MenuItems
                        transition
                        className="absolute right-0 z-10 mt-2 w-72 origin-top-right rounded-lg bg-white ring-1 ring-black/5 shadow-xl transition focus:outline-none data-[closed]:scale-95 data-[closed]:opacity-0 data-[enter]:duration-100 data-[leave]:duration-75 data-[enter]:ease-out data-[leave]:ease-in overflow-hidden"
                      >
                        {/* Friend requests section */}
                        <div className="px-4 py-2.5 border-b border-gray-100">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                            Friend Requests
                            {pendingRequests.length > 0 && (
                              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{pendingRequests.length}</span>
                            )}
                          </p>
                        </div>
                        {pendingRequests.length === 0 ? (
                          <p className="px-4 py-3 text-sm text-gray-400 italic">No pending requests</p>
                        ) : (
                          <div className="py-1 max-h-48 overflow-y-auto">
                            {pendingRequests.map((r) => (
                              <MenuItem key={r.id}>
                                <div className="flex items-center justify-between px-4 py-2.5 gap-3">
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium text-gray-800 truncate">{r.sender.username}</p>
                                    <p className="text-xs text-gray-400">wants to be friends</p>
                                  </div>
                                  <div className="flex gap-1.5 shrink-0">
                                    <button
                                      onClick={() => handleAccept(r.id)}
                                      className="rounded px-2 py-1 text-xs font-semibold bg-orange-500 text-white hover:bg-orange-400 transition-colors"
                                    >
                                      Accept
                                    </button>
                                    <button
                                      onClick={() => handleReject(r.id)}
                                      className="rounded px-2 py-1 text-xs font-medium text-gray-400 hover:text-red-400 transition-colors"
                                    >
                                      Decline
                                    </button>
                                  </div>
                                </div>
                              </MenuItem>
                            ))}
                          </div>
                        )}

                        {/* Group invites section */}
                        <div className="px-4 py-2.5 border-y border-gray-100">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                            Group Invites
                            {pendingGroupInvites.length > 0 && (
                              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{pendingGroupInvites.length}</span>
                            )}
                          </p>
                        </div>
                        {pendingGroupInvites.length === 0 ? (
                          <p className="px-4 py-3 text-sm text-gray-400 italic">No pending invites</p>
                        ) : (
                          <div className="py-1 max-h-48 overflow-y-auto">
                            {pendingGroupInvites.map((inv) => (
                              <MenuItem key={inv.id}>
                                <div className="flex items-center justify-between px-4 py-2.5 gap-3">
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium text-gray-800 truncate">{inv.group.name}</p>
                                    <p className="text-xs text-gray-400">from {inv.invitedBy.username}</p>
                                  </div>
                                  <div className="flex gap-1.5 shrink-0">
                                    <button
                                      onClick={() => handleGroupInviteRespond(inv, 'accept')}
                                      className="rounded px-2 py-1 text-xs font-semibold bg-orange-500 text-white hover:bg-orange-400 transition-colors"
                                    >
                                      Accept
                                    </button>
                                    <button
                                      onClick={() => handleGroupInviteRespond(inv, 'decline')}
                                      className="rounded px-2 py-1 text-xs font-medium text-gray-400 hover:text-red-400 transition-colors"
                                    >
                                      Decline
                                    </button>
                                  </div>
                                </div>
                              </MenuItem>
                            ))}
                          </div>
                        )}

                        {/* Trip invites — same structure as group invites
                            above, just routed through the trips API. */}
                        <div className="px-4 py-2.5 border-y border-gray-100">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                            Trip Invites
                            {pendingTripInvites.length > 0 && (
                              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{pendingTripInvites.length}</span>
                            )}
                          </p>
                        </div>
                        {pendingTripInvites.length === 0 ? (
                          <p className="px-4 py-3 text-sm text-gray-400 italic">No pending trip invites</p>
                        ) : (
                          <div className="py-1 max-h-48 overflow-y-auto">
                            {pendingTripInvites.map((inv) => (
                              <MenuItem key={inv.id}>
                                <div className="flex items-center justify-between px-4 py-2.5 gap-3">
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium text-gray-800 truncate">{inv.trip.name}</p>
                                    <p className="text-xs text-gray-400 truncate">
                                      {inv.trip.destination} · from {inv.invitedBy.username}
                                    </p>
                                  </div>
                                  <div className="flex gap-1.5 shrink-0">
                                    <button
                                      onClick={() => handleTripInviteRespond(inv, 'accept')}
                                      className="rounded px-2 py-1 text-xs font-semibold bg-orange-500 text-white hover:bg-orange-400 transition-colors"
                                    >
                                      Accept
                                    </button>
                                    <button
                                      onClick={() => handleTripInviteRespond(inv, 'decline')}
                                      className="rounded px-2 py-1 text-xs font-medium text-gray-400 hover:text-red-400 transition-colors"
                                    >
                                      Decline
                                    </button>
                                  </div>
                                </div>
                              </MenuItem>
                            ))}
                          </div>
                        )}

                        {/* Trip meal participation — meals where you're in
                            the host's explicit participant list. Links to the
                            trip detail page so the user can see the candidates
                            and (when host-permitted) vote. No accept/decline
                            buttons: the user is already a trip member, this
                            is just a "you're up" reminder. */}
                        {participantMeals.length > 0 && (
                          <>
                            <div className="px-4 py-2.5 border-y border-gray-100">
                              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                                Your Meals
                                <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{participantMeals.length}</span>
                              </p>
                            </div>
                            <div className="py-1 max-h-48 overflow-y-auto">
                              {participantMeals.map((m) => {
                                // Send voting meals straight to the live session;
                                // OPEN ones go to the trip detail page where the
                                // user can see the candidates.
                                const dest = m.status === 'VOTING' && m.sessionId
                                  ? `/vote/${m.sessionId}`
                                  : `/trips/${m.tripId}`;
                                return (
                                  <MenuItem key={m.id}>
                                    <Link
                                      to={dest}
                                      className="flex items-center justify-between px-4 py-2.5 gap-3 hover:bg-orange-50 transition-colors"
                                    >
                                      <div className="min-w-0">
                                        <p className="text-sm font-medium text-gray-800 truncate">{m.name}</p>
                                        <p className="text-xs text-gray-400 truncate">
                                          {m.trip.name}
                                          {m.createdBy && <> · from {m.createdBy.username}</>}
                                        </p>
                                      </div>
                                      <span className="text-gray-400 text-xs shrink-0">→</span>
                                    </Link>
                                  </MenuItem>
                                );
                              })}
                            </div>
                          </>
                        )}

                        {/* Voting in progress section — one entry per live event */}
                        {activeVotes.length > 0 && (
                          <>
                            <div className="px-4 py-2.5 border-t border-gray-100">
                              <p className="text-xs font-semibold text-orange-500 uppercase tracking-wider">
                                Voting In Progress
                                <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-orange-500 text-white text-[9px] font-bold">{activeVotes.length}</span>
                              </p>
                            </div>
                            <div className="py-1">
                              {activeVotes.map((v) => (
                                <MenuItem key={`${v.groupId}-${v.eventId}`}>
                                  <Link
                                    to={`/vote/${v.sessionId}`}
                                    className="flex items-center justify-between px-4 py-2.5 gap-3 hover:bg-orange-50 transition-colors"
                                  >
                                    <div className="min-w-0">
                                      <p className="text-sm font-medium text-gray-800 truncate">{v.eventName}</p>
                                      <p className="text-xs text-orange-500 truncate">
                                        🗳 {v.groupName} — voting open
                                      </p>
                                    </div>
                                    <span className="text-gray-400 text-xs shrink-0">→</span>
                                  </Link>
                                </MenuItem>
                              ))}
                            </div>
                          </>
                        )}
                      </MenuItems>
                    </Menu>
                  )}

                  {/* Profile dropdown / Sign in */}
                  {isAuthenticated ? (
                    <Menu as="div" className="relative ml-1">
                      <MenuButton className="flex items-center rounded-full bg-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:ring-offset-white">
                        <span className="sr-only">Open user menu</span>
                        <GenericAvatar src={userAvatar} />
                      </MenuButton>

                      <MenuItems
                        transition
                        className="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-lg bg-white ring-1 ring-black/5 shadow-xl transition focus:outline-none data-[closed]:scale-95 data-[closed]:opacity-0 data-[enter]:duration-100 data-[leave]:duration-75 data-[enter]:ease-out data-[leave]:ease-in overflow-hidden py-1"
                      >
                        {userNavigation.map((item) => (
                          <MenuItem key={item.name}>
                            <Link
                              to={item.link}
                              className="block px-4 py-2 text-sm text-gray-700 hover:bg-orange-50 hover:text-orange-600 transition-colors"
                            >
                              {item.name}
                            </Link>
                          </MenuItem>
                        ))}
                        <MenuItem>
                          <button
                            onClick={handleLogout}
                            className="w-full text-left block px-4 py-2 text-sm text-gray-700 hover:bg-orange-50 hover:text-orange-600 transition-colors"
                          >
                            Log out
                          </button>
                        </MenuItem>
                      </MenuItems>
                    </Menu>
                  ) : (
                    <Link
                      to="/authentication"
                      className="bg-gradient-to-br from-orange-500 to-red-500 text-white rounded-lg px-4 py-2 text-sm font-semibold shadow-brand-sm hover:from-orange-400 hover:to-red-400 transition-all ml-1"
                    >
                      Log in / Sign up
                    </Link>
                  )}
                </div>

                {/* Mobile hamburger */}
                <div className="flex md:hidden">
                  <DisclosureButton className="group relative inline-flex items-center justify-center rounded-md bg-white p-2 text-stone-500 hover:bg-orange-50 hover:text-orange-600 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:ring-offset-white">
                    <span className="absolute -inset-0.5" />
                    <span className="sr-only">Open main menu</span>
                    <Bars3Icon aria-hidden="true" className="block h-6 w-6 group-data-[open]:hidden" />
                    <XMarkIcon aria-hidden="true" className="hidden h-6 w-6 group-data-[open]:block" />
                  </DisclosureButton>
                </div>
              </div>
            </div>
          </div>

          {/* Mobile menu panel */}
          <DisclosurePanel className="md:hidden border-t border-orange-100 bg-white">
            {/* Nav links */}
            <div className="px-2 pt-2 pb-3 space-y-1">
              {navigation.filter((item) => !item.authOnly || isAuthenticated).map((item) => (
                <DisclosureButton
                  key={item.name}
                  as={Link}
                  to={item.link}
                  aria-current={item.active ? 'page' : undefined}
                  className={classNames(
                    item.active
                      ? 'bg-orange-50 text-orange-600 font-semibold'
                      : 'text-stone-500 hover:bg-orange-50 hover:text-orange-600',
                    'block rounded-md px-3 py-2 text-base font-medium transition-colors'
                  )}
                >
                  <span className="flex items-center gap-2">
                    {item.name}
                    {item.name === 'Groups' && (pendingGroupInvites.length + activeVotes.length) > 0 && (
                      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{pendingGroupInvites.length + activeVotes.length}</span>
                    )}
                    {item.name === 'Trips' && (pendingTripInvites.length + participantMeals.length) > 0 && (
                      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{pendingTripInvites.length + participantMeals.length}</span>
                    )}
                  </span>
                </DisclosureButton>
              ))}
            </div>

            {/* Friend requests — mobile */}
            {isAuthenticated && pendingRequests.length > 0 && (
              <div className="border-t border-orange-100 px-4 py-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  Friend Requests
                  <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{pendingRequests.length}</span>
                </p>
                <div className="flex flex-col gap-2">
                  {pendingRequests.map((r) => (
                    <div key={r.id} className="flex items-center justify-between text-sm">
                      <span className="text-gray-700">{r.sender.username}</span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleAccept(r.id)}
                          className="rounded px-2 py-1 text-xs font-semibold bg-orange-500 text-white hover:bg-orange-400 transition-colors"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => handleReject(r.id)}
                          className="text-xs text-gray-500 hover:text-red-400 transition-colors"
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Group invites — mobile */}
            {isAuthenticated && pendingGroupInvites.length > 0 && (
              <div className="border-t border-orange-100 px-4 py-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  Group Invites
                  <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{pendingGroupInvites.length}</span>
                </p>
                <div className="flex flex-col gap-2">
                  {pendingGroupInvites.map((inv) => (
                    <div key={inv.id} className="flex items-start justify-between text-sm gap-2">
                      <div className="min-w-0">
                        <p className="text-gray-700 truncate">{inv.group.name}</p>
                        <p className="text-xs text-gray-400">from {inv.invitedBy.username}</p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => handleGroupInviteRespond(inv, 'accept')}
                          className="rounded px-2 py-1 text-xs font-semibold bg-orange-500 text-white hover:bg-orange-400 transition-colors"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => handleGroupInviteRespond(inv, 'decline')}
                          className="text-xs text-gray-500 hover:text-red-400 transition-colors"
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Trip invites — mobile */}
            {isAuthenticated && pendingTripInvites.length > 0 && (
              <div className="border-t border-orange-100 px-4 py-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  Trip Invites
                  <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{pendingTripInvites.length}</span>
                </p>
                <div className="flex flex-col gap-2">
                  {pendingTripInvites.map((inv) => (
                    <div key={inv.id} className="flex items-start justify-between text-sm gap-2">
                      <div className="min-w-0">
                        <p className="text-gray-700 truncate">{inv.trip.name}</p>
                        <p className="text-xs text-gray-400">{inv.trip.destination} · from {inv.invitedBy.username}</p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => handleTripInviteRespond(inv, 'accept')}
                          className="rounded px-2 py-1 text-xs font-semibold bg-orange-500 text-white hover:bg-orange-400 transition-colors"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => handleTripInviteRespond(inv, 'decline')}
                          className="text-xs text-gray-500 hover:text-red-400 transition-colors"
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Your meals — mobile */}
            {isAuthenticated && participantMeals.length > 0 && (
              <div className="border-t border-orange-100 px-4 py-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  Your Meals
                  <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{participantMeals.length}</span>
                </p>
                <div className="flex flex-col gap-2">
                  {participantMeals.map((m) => {
                    const dest = m.status === 'VOTING' && m.sessionId
                      ? `/vote/${m.sessionId}`
                      : `/trips/${m.tripId}`;
                    return (
                      <DisclosureButton
                        key={m.id}
                        as={Link}
                        to={dest}
                        className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-orange-50 transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">{m.name}</p>
                          <p className="text-xs text-gray-400 truncate">
                            {m.trip.name}
                            {m.createdBy && <> · from {m.createdBy.username}</>}
                          </p>
                        </div>
                        <span className="text-gray-400 text-xs shrink-0">→</span>
                      </DisclosureButton>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Active votes — mobile */}
            {isAuthenticated && activeVotes.length > 0 && (
              <div className="border-t border-orange-100 px-4 py-3">
                <p className="text-xs font-semibold text-orange-500 uppercase tracking-wider mb-2">
                  Voting In Progress
                  <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-orange-500 text-white text-[9px] font-bold">{activeVotes.length}</span>
                </p>
                <div className="flex flex-col gap-2">
                  {activeVotes.map((v) => (
                    <DisclosureButton
                      key={`${v.groupId}-${v.eventId}`}
                      as={Link}
                      to={`/vote/${v.sessionId}`}
                      className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-orange-50 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{v.eventName}</p>
                        <p className="text-xs text-orange-500 truncate">🗳 {v.groupName} — tap to vote</p>
                      </div>
                      <span className="text-gray-400 text-xs shrink-0">→</span>
                    </DisclosureButton>
                  ))}
                </div>
              </div>
            )}

            {/* User section */}
            <div className="border-t border-orange-100 pt-3 pb-4 px-2">
              {isAuthenticated ? (
                <>
                  {userNavigation.map((item) => (
                    <DisclosureButton
                      key={item.name}
                      as={Link}
                      to={item.link}
                      className="block rounded-md px-3 py-2 text-base font-medium text-stone-500 hover:bg-orange-50 hover:text-orange-600 transition-colors"
                    >
                      {item.name}
                    </DisclosureButton>
                  ))}
                  <DisclosureButton
                    as="button"
                    onClick={handleLogout}
                    className="block w-full text-left rounded-md px-3 py-2 text-base font-medium text-stone-500 hover:bg-orange-50 hover:text-orange-600 transition-colors"
                  >
                    Log out
                  </DisclosureButton>
                </>
              ) : (
                <DisclosureButton
                  as={Link}
                  to="/authentication"
                  className="block rounded-md px-3 py-2 text-base font-semibold text-orange-600 hover:bg-orange-50 transition-colors"
                >
                  Log in / Sign up
                </DisclosureButton>
              )}
            </div>
          </DisclosurePanel>
        </Disclosure>

        {/* Verify-your-email banner — shown on every page when the auth'd
            user hasn't clicked the link in their welcome email yet. The
            "Resend" button hits /api/auth/resend-verification (rate-limited
            server-side). Dismissable via the X — dismissal is per-session
            (sessionStorage) so it returns on the next sign-in. */}
        {isAuthenticated && !isEmailVerified && (
          <EmailVerifyBanner email={userEmail} />
        )}

        {/* Banner shows the Options chip list on pages where it adds value as
            an always-visible reminder — Search (/), Compare (/restaurant), and
            Socials. Suppressed on /choose because that page already renders the
            full Options grid with the same affordances (click to inspect, ✕ to
            remove); the chips just steal vertical space and duplicate state. */}
        {(pathname === '/' || pathname.startsWith('/restaurant') || pathname.startsWith('/socials')) && (
        <header className="bg-gradient-to-r from-orange-50 to-amber-50 border-b border-orange-200">
          <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8 flex items-center gap-3 flex-wrap">
            <h1 className="text-xs font-bold tracking-widest text-orange-800 uppercase shrink-0">Options</h1>
            {currentOptions.length === 0 ? (
              <span className="text-sm text-orange-400 italic">No options yet — add one from the Search page.</span>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                {currentOptions.map((id) => {
                  const name = allRestaurants[id]?.name ?? 'Custom entry';
                  return (
                    <div
                      key={id}
                      className="flex items-center gap-1 rounded-full border border-orange-300 bg-white shadow-sm px-3 py-1 hover:border-orange-400 hover:shadow-brand-sm transition-all cursor-pointer"
                      onClick={() => setDetailId(id)}
                    >
                      <span className="text-sm font-medium text-orange-900">{name}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); dispatch(removeUserOption(id)); }}
                        className="ml-0.5 text-orange-400 hover:text-red-500 leading-none transition-colors text-xs font-bold"
                        aria-label={`Remove ${name}`}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </header>
        )}

      {!isAuthenticated && (
        <div className="bg-orange-50 border-b border-orange-200">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-2 flex items-center justify-between gap-4">
            <p className="text-xs text-orange-800">
              You're browsing as a guest — your options, favorites, and history will be lost when you leave.
            </p>
            <Link
              to="/authentication"
              className="shrink-0 text-xs font-semibold text-orange-600 bg-white border border-orange-300 rounded-md px-3 py-1 hover:bg-orange-50 transition-colors"
            >
              Sign in to save your data
            </Link>
          </div>
        </div>
      )}

      {/* Outlet wrapped in a flex-1 main so it absorbs vertical slack and
          pushes the Footer to the bottom of the viewport on short pages.
          Routes that want their own internal flex layout can wrap their
          root in `flex flex-col h-full` to fill this container. */}
      <main className="flex-1 flex flex-col">
        <Outlet />
      </main>
      <Footer />
      </div>{/* /app shell */}

      {detailId && (
        <RestaurantDetailModal
          restaurantId={detailId}
          restaurantMap={allRestaurants}
          onClose={() => setDetailId(null)}
        />
      )}
    </>
  );
};

export default NavBar;
