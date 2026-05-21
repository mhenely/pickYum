import { useState, useEffect, useCallback } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import Footer from "./Footer";
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import { BellIcon } from '@heroicons/react/24/outline'
import { useDispatch, useSelector } from "react-redux";
import { removeUserOption } from "../redux/slices/userInfoSlice";
import { logoutUser } from "../redux/slices/authSlice";
import { pushToast } from "../redux/slices/toastSlice";
import useCurrentUser from "../hooks/useCurrentUser";
import RestaurantDetailModal from "./RestaurantDetailModal";
import EmailVerifyBanner from "./nav/EmailVerifyBanner";
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
  // Gate guest-mode UI on the explicit 'unauthenticated' status rather than
  // `!isAuthenticated`, which is also true during 'idle' / 'loading'. Without
  // this, every refresh briefly flashes the "you're a guest" banner and the
  // "Sign in" button while checkAuth is in flight.
  const isUnauthenticated = useSelector((state) => state.auth.status === 'unauthenticated');
  // Flips true once loadUserData lands. We use it to gate the Options
  // chip strip below — without this, refreshes flash the "No options
  // yet" empty state while the real options list is in flight.
  const isDataLoaded = useSelector((state) => state.userInfo.isDataLoaded);
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
      } else if (reason === 'meal-participant') {
        // Fires for both subset meals (you were specifically added) and
        // "everyone" meals (just added to a trip you're in). Generic copy
        // works for both — the bell badge handles surfacing subset rows.
        dispatch(pushToast({
          id: `meal-${Date.now()}`,
          status: 'info',
          label: 'A new meal was added to a trip you\'re in.',
        }));
      }
    });
    // No need to handle the default `message` event — the server only
    // emits typed refreshes plus heartbeat comments (which EventSource
    // ignores). errors trigger the built-in retry; we just close on
    // unmount so a re-mount opens a fresh connection.
    return () => { es.close(); };
  }, [isAuthenticated, fetchNotifications, dispatch]);

  // Tiny helper so every accept/decline path below toasts with the same
  // shape. The previous handlers were silent on success — users had to
  // watch the bell badge to confirm anything happened.
  const showInviteToast = (label, status = 'success') =>
    dispatch(pushToast({ id: `invite-${Date.now()}`, status, label }));

  const handleAccept = async (requestId) => {
    try {
      await socialApi.respondRequest(requestId, 'accept');
      await fetchNotifications();
      showInviteToast('Friend request accepted.');
    } catch { showInviteToast('Could not respond to friend request.', 'error'); }
  };

  const handleReject = async (requestId) => {
    try {
      await socialApi.respondRequest(requestId, 'reject');
      await fetchNotifications();
      showInviteToast('Friend request declined.');
    } catch { showInviteToast('Could not respond to friend request.', 'error'); }
  };

  const handleGroupInviteRespond = async (invite, action) => {
    try {
      await groupsApi.respondInvite(invite.group.id, invite.id, action);
      await fetchNotifications();
      const verb = action === 'accept' ? 'Joined' : 'Declined invite to';
      showInviteToast(`${verb} ${invite.group?.name ?? 'group'}.`);
    } catch { showInviteToast('Could not respond to group invite.', 'error'); }
  };

  const handleTripInviteRespond = async (invite, action) => {
    try {
      await api.trips.respondToInvite(invite.tripId, invite.id, action);
      await fetchNotifications();
      const verb = action === 'accept' ? 'Joined trip' : 'Declined invite to';
      showInviteToast(`${verb} ${invite.tripName ?? ''}`.trim() + '.');
    } catch { showInviteToast('Could not respond to trip invite.', 'error'); }
  };

  const handleLogout = () => {
    // The auth slice + listener wipe local user data on BOTH fulfilled and
    // rejected, so `.then()` works for the navigation regardless of API
    // outcome. The user lands on home with no residual data either way.
    dispatch(logoutUser()).then(() => navigate('/'));
  };

  // 4-item desktop top nav + 5-item mobile bottom-tab bar. The two share
  // this list; the mobile bar adds 'You' as a 5th entry. Compare stays in
  // both because it's the entry point for the favorites-compare flow (the
  // page has a favorites sidebar). Insights / History / Settings consolidated
  // into /you, reached via the avatar on desktop and the You tab on mobile.
  //
  // The 'Social' entry covers Groups + Trips + People + Recs — all
  // multi-user surfaces in one place. It's still authOnly; for guests the
  // desktop nav drops it and the mobile bar keeps the slot active but
  // routes to the auth wall via ProtectedRoute.
  // /you is the new consolidated personal hub (Phase 3). Old per-user
  // paths still resolve so existing bookmarks/links keep working until
  // Phase 4 wires redirects.
  const youLink = '/you';
  const socialBadge = pendingGroupInvites.length + pendingTripInvites.length + activeVotes.length;
  const navigation = [
    { name: 'Search',   link: '/',                 active: pathname === '/' },
    { name: 'Compare',  link: '/restaurant',       active: pathname.startsWith('/restaurant') },
    { name: 'Choose',   link: `/choose/${userId}`, active: pathname.startsWith('/choose') },
    {
      name: 'Social',
      link: '/socials',
      active: pathname.startsWith('/socials') || pathname.startsWith('/groups') || pathname.startsWith('/trips'),
      authOnly: true,
      badge: socialBadge,
    },
  ];

  // Mobile-only 5th slot. Desktop's avatar in the top bar plays the same
  // role; keeping it as a tab on mobile means the bottom bar stays the
  // single source of truth there.
  const mobileNavigation = [
    ...navigation,
    { name: 'You', link: youLink, active: pathname.startsWith('/you') || pathname.startsWith('/userInfo') || pathname.startsWith('/History') || pathname.startsWith('/insights'), authOnly: true },
  ];

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
        <nav
          className="bg-white border-b border-orange-200 sticky top-0 z-30 md:bg-white/90 md:backdrop-blur-sm"
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
                        {item.badge > 0 && (
                          <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none">
                            {item.badge}
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

                  {/* Avatar dropdown — quick access to /you + Log out from
                      anywhere. The dropdown was dropped in Phase 1 in favor of
                      a direct avatar link, but burying Log out two clicks deep
                      (avatar → Account tab → button) was real friction; this
                      restores parity with the pre-merge UX. During
                      'idle'/'loading' we render a neutral placeholder so the
                      slot doesn't flicker between the Sign-in CTA and the
                      avatar on every refresh. */}
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
                        <MenuItem>
                          <Link
                            to={youLink}
                            className="block px-4 py-2 text-sm text-gray-700 hover:bg-orange-50 hover:text-orange-600 transition-colors"
                          >
                            Your profile
                          </Link>
                        </MenuItem>
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
                  ) : isUnauthenticated ? (
                    <Link
                      to="/authentication"
                      className="bg-gradient-to-br from-orange-500 to-red-500 text-white rounded-lg px-4 py-2 text-sm font-semibold shadow-brand-sm hover:from-orange-400 hover:to-red-400 transition-all ml-1"
                    >
                      Log in / Sign up
                    </Link>
                  ) : (
                    <div className="ml-1 h-8 w-8 rounded-full bg-gray-100 animate-pulse" aria-hidden="true" />
                  )}
                </div>
              </div>
            </div>
          </div>

        </nav>

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
            remove); the chips just steal vertical space and duplicate state.
            Also suppressed on `/` for unauthenticated visitors, where the
            page renders the marketing landing — "Options: No options yet"
            on top of a sign-up hero reads as a broken UI to first-timers. */}
        {(
          (pathname === '/' && !isUnauthenticated) ||
          pathname.startsWith('/restaurant') ||
          pathname.startsWith('/socials')
        ) && (
        <header className="bg-gradient-to-r from-orange-50 to-amber-50 border-b border-orange-200">
          <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8 flex items-center gap-3 flex-wrap">
            <h1 className="text-xs font-bold tracking-widest text-orange-800 uppercase shrink-0">Options</h1>
            {/* While authenticated but data is in flight, show skeleton
                chips so refreshes don't briefly flash "No options yet"
                before the real options list lands. Guest users (no
                pending loadUserData) skip the skeleton — their empty
                state is the truth, not a transient. */}
            {!isUnauthenticated && !isDataLoaded ? (
              <div className="flex items-center gap-2" aria-hidden="true">
                <div className="h-7 w-24 rounded-full bg-orange-100 animate-pulse" />
                <div className="h-7 w-32 rounded-full bg-orange-100 animate-pulse" />
                <div className="h-7 w-20 rounded-full bg-orange-100 animate-pulse" />
              </div>
            ) : currentOptions.length === 0 ? (
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

      {/* Guest reminder. Hidden on `/` because the landing page itself
          is the sign-up pitch — repeating the prompt would just look
          like duplicate UI. Still rendered everywhere else so guest
          mode never feels permanent. */}
      {isUnauthenticated && pathname !== '/' && (
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
          root in `flex flex-col h-full` to fill this container.
          pb-20 on mobile so the last row of content clears the fixed bottom
          tab bar (h-16 + breathing room); md:pb-0 since desktop has no
          bottom bar. */}
      <main className="flex-1 flex flex-col pb-20 md:pb-0">
        <Outlet />
      </main>
      <Footer />

      {/* Mobile bottom-tab bar. Fixed to the viewport bottom so it's always
          reachable by thumb regardless of page scroll position. Hidden on
          md:+ where the top nav carries the same destinations.
          z-30 matches the top nav; modals (z-50+) draw above it.
          The active tab gets the orange-50 background + top border to
          mirror the desktop top-nav pill styling. */}
      {!isUnauthenticated && (
        <nav
          aria-label="Primary"
          className="md:hidden fixed bottom-0 inset-x-0 bg-white border-t border-orange-200 grid grid-cols-5 z-30"
          style={{boxShadow: '0 -2px 12px rgba(234,88,12,0.08)'}}
        >
          {mobileNavigation.filter((item) => !item.authOnly || isAuthenticated).map((item) => (
            <Link
              key={item.name}
              to={item.link}
              aria-current={item.active ? 'page' : undefined}
              className={classNames(
                'relative flex flex-col items-center justify-center py-2 text-xs transition-colors',
                item.active
                  ? 'text-orange-600 bg-orange-50 border-t-2 border-orange-500 -mt-px font-semibold'
                  : 'text-stone-500 hover:text-orange-600 border-t-2 border-transparent -mt-px'
              )}
            >
              <span className="text-lg leading-none mb-0.5" aria-hidden="true">
                {item.name === 'Search' && '🔍'}
                {item.name === 'Compare' && '⚖️'}
                {item.name === 'Choose' && '🎲'}
                {item.name === 'Social' && '👥'}
                {item.name === 'You' && '📊'}
              </span>
              <span>{item.name}</span>
              {item.badge > 0 && (
                <span className="absolute top-1 right-3 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">
                  {item.badge}
                </span>
              )}
            </Link>
          ))}
        </nav>
      )}
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
