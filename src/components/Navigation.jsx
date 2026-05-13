import { useState, useEffect, useCallback } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import Footer from "./Footer";
import { Disclosure, DisclosureButton, DisclosurePanel, Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import { Bars3Icon, XMarkIcon, BellIcon } from '@heroicons/react/24/outline'
import { useDispatch, useSelector } from "react-redux";
import { removeUserSelection } from "../redux/slices/userInfoSlice";
import { logoutUser } from "../redux/slices/authSlice";
import useCurrentUser from "../hooks/useCurrentUser";
import RestaurantDetailModal from "./RestaurantDetailModal";
import { socialApi } from "../lib/socialApi";
import { groupsApi } from "../lib/groupsApi";

const GenericAvatar = () => (
  <div className="h-8 w-8 rounded-full bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center shadow-brand-sm">
    <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
    </svg>
  </div>
);

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

const NavBar = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const [detailId, setDetailId] = useState(null);
  const currentSelections = currentUser.selections;
  const userId = currentUser.id;
  const dispatch = useDispatch();
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const allRestaurants = customRestaurants;
  const isAuthenticated = useSelector((state) => state.auth.status === 'authenticated');

  // ── Notifications (friend requests + group invites + voting alerts) ─
  const [pendingRequests, setPendingRequests] = useState([]);
  const [pendingGroupInvites, setPendingGroupInvites] = useState([]);
  const [votingGroups, setVotingGroups] = useState([]);

  const fetchNotifications = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const [{ requests }, { pendingInvites, groups }] = await Promise.all([
        socialApi.getIncoming(),
        groupsApi.list(),
      ]);
      setPendingRequests(requests);
      setPendingGroupInvites(pendingInvites);
      setVotingGroups((groups ?? []).filter((g) => g.status === 'VOTING'));
    } catch { /* non-fatal */ }
  }, [isAuthenticated]);

  // Background poll for incoming friend requests, group invites, and live votes.
  // 60s is a compromise: tight enough to feel near-realtime for invites, loose
  // enough that two background tabs aren't generating one request/sec total.
  const NOTIFICATIONS_POLL_INTERVAL_MS = 60_000;
  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, NOTIFICATIONS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

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

  const handleLogout = () => {
    dispatch(logoutUser()).then(() => navigate('/'));
  };

  const navigation = [
    { name: 'Search',  link: '/',                active: pathname === '/' },
    { name: 'Compare', link: '/restaurant',       active: pathname.startsWith('/restaurant') },
    { name: 'Choose',  link: `/choose/${userId}`, active: pathname.startsWith('/choose') },
    { name: 'Socials', link: '/socials',          active: pathname.startsWith('/socials') || pathname.startsWith('/groups'), authOnly: true },
  ];

  const userNavigation = isAuthenticated
    ? [
        { name: 'Your Info',    link: `/userInfo/${userId}` },
        { name: 'Your History', link: `/History/${userId}` },
      ]
    : [];

  return (
    <>
      <div className="min-h-full">
        <Disclosure as="nav" className="bg-white border-b border-orange-200" style={{boxShadow: '0 1px 0 #fed7aa, 0 4px 12px rgba(234,88,12,0.06)'}}>
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
                        {item.name === 'Groups' && (pendingGroupInvites.length + votingGroups.length) > 0 && (
                          <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none">
                            {pendingGroupInvites.length + votingGroups.length}
                          </span>
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right side: desktop controls + mobile hamburger */}
              <div className="flex items-center gap-2">

                {/* Desktop: Selections dropdown + profile */}
                <div className="hidden md:flex items-center gap-2">

                  {/* Notifications bell */}
                  {isAuthenticated && (
                    <Menu as="div" className="relative">
                      <MenuButton className="relative flex items-center rounded-md p-2 text-stone-500 hover:bg-orange-50 hover:text-orange-600 transition-colors">
                        <BellIcon className="h-5 w-5" />
                        {(pendingRequests.length + pendingGroupInvites.length + votingGroups.length) > 0 && (
                          <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none">
                            {pendingRequests.length + pendingGroupInvites.length + votingGroups.length}
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

                        {/* Voting in progress section */}
                        {votingGroups.length > 0 && (
                          <>
                            <div className="px-4 py-2.5 border-t border-gray-100">
                              <p className="text-xs font-semibold text-orange-500 uppercase tracking-wider">
                                Voting In Progress
                                <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-orange-500 text-white text-[9px] font-bold">{votingGroups.length}</span>
                              </p>
                            </div>
                            <div className="py-1">
                              {votingGroups.map((g) => (
                                <MenuItem key={g.id}>
                                  <Link
                                    to={g.sessionId ? `/vote/${g.sessionId}` : '/groups'}
                                    className="flex items-center justify-between px-4 py-2.5 gap-3 hover:bg-orange-50 transition-colors"
                                  >
                                    <div className="min-w-0">
                                      <p className="text-sm font-medium text-gray-800 truncate">{g.name}</p>
                                      <p className="text-xs text-orange-500">🗳 Voting is open — join now</p>
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
                        <GenericAvatar />
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
                    {item.name === 'Groups' && (pendingGroupInvites.length + votingGroups.length) > 0 && (
                      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{pendingGroupInvites.length + votingGroups.length}</span>
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

        {(pathname === '/' || pathname.startsWith('/choose') || pathname.startsWith('/restaurant') || pathname.startsWith('/socials')) && (
        <header className="bg-gradient-to-r from-orange-50 to-amber-50 border-b border-orange-200">
          <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8 flex items-center gap-3 flex-wrap">
            <h1 className="text-xs font-bold tracking-widest text-orange-800 uppercase shrink-0">Selections</h1>
            {currentSelections.length === 0 ? (
              <span className="text-sm text-orange-400 italic">No selections yet — add one from the Search page.</span>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                {currentSelections.map((id) => {
                  const name = allRestaurants[id]?.name ?? 'Custom entry';
                  return (
                    <div
                      key={id}
                      className="flex items-center gap-1 rounded-full border border-orange-300 bg-white shadow-sm px-3 py-1 hover:border-orange-400 hover:shadow-brand-sm transition-all cursor-pointer"
                      onClick={() => setDetailId(id)}
                    >
                      <span className="text-sm font-medium text-orange-900">{name}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); dispatch(removeUserSelection(id)); }}
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
      </div>

      {!isAuthenticated && (
        <div className="bg-orange-50 border-b border-orange-200">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-2 flex items-center justify-between gap-4">
            <p className="text-xs text-orange-800">
              You're browsing as a guest — your selections, favorites, and history will be lost when you leave.
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
      <Outlet />
      <Footer />

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
