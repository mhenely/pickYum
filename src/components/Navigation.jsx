import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { Disclosure, DisclosureButton, Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import { Bars3Icon, XMarkIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { useDispatch, useSelector } from "react-redux";
import { restaurants } from "../tempData/restaurants";
import { removeUserSelection } from "../redux/slices/userInfoSlice";
import useCurrentUser from "../hooks/useCurrentUser";
import RestaurantDetailModal from "./RestaurantDetailModal";

const userAvatar = 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80';

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

const NavBar = () => {
  const { pathname } = useLocation();
  const currentUser = useCurrentUser();
  const [detailId, setDetailId] = useState(null);
  const currentSelections = currentUser.selections;
  const userId = currentUser.id;
  const dispatch = useDispatch();
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const allRestaurants = { ...restaurants, ...customRestaurants };

  // Active-route matcher: returns true when the current pathname belongs to this nav item.
  const navigation = [
    { name: 'Search',       link: '/',                      active: pathname === '/' },
    { name: 'Choose',       link: `/choose/${userId}`,      active: pathname.startsWith('/choose') },
    { name: 'Restaurant',   link: '/restaurant/1',          active: pathname.startsWith('/restaurant') },
    { name: 'History', link: `/History/${userId}`, active: pathname.startsWith('/History') },
    // { name: 'User Info',    link: `/userInfo/${userId}`,    active: pathname.startsWith('/userInfo') },
  ];

  const userNavigation = [
    { name: 'Your info',       link: `/userInfo/${userId}` },
    { name: 'Authentication',  link: 'authentication' },
  ];

  return (
    <>
      <div className="min-h-full">
        <Disclosure as="nav" className="bg-gray-800">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="flex h-16 items-center justify-center">

              {/* Logo + nav links */}
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <img
                    alt="pickYum"
                    src="https://tailwindui.com/img/logos/mark.svg?color=indigo&shade=500"
                    className="h-8 w-8"
                  />
                </div>
                <div className="hidden md:block">
                  <div className="ml-10 flex items-baseline space-x-1">
                    {navigation.map((item) => (
                      <Link
                        key={item.name}
                        to={item.link}
                        aria-current={item.active ? 'page' : undefined}
                        className={classNames(
                          item.active
                            ? 'bg-gray-900 text-white'
                            : 'text-gray-300 hover:bg-gray-700 hover:text-white',
                          'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        )}
                      >
                        {item.name}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right-side controls */}
              <div className="hidden md:block">
                <div className="ml-4 flex items-center md:ml-6 gap-2">

                  {/* ── Selections dropdown ───────────────────── */}
                  <Menu as="div" className="relative">
                    <MenuButton className="flex items-center gap-1 text-gray-300 hover:bg-gray-700 hover:text-white rounded-md px-3 py-2 text-sm font-medium transition-colors">
                      Selections
                      {currentSelections.length > 0 && (
                        <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-indigo-500 text-white text-[10px] font-bold leading-none">
                          {currentSelections.length}
                        </span>
                      )}
                      <ChevronDownIcon className="h-3.5 w-3.5 ml-0.5 opacity-70" />
                    </MenuButton>

                    <MenuItems
                      transition
                      className="absolute right-0 z-10 mt-2 w-56 origin-top-right rounded-lg bg-gray-800 ring-1 ring-white/10 shadow-xl transition focus:outline-none data-[closed]:scale-95 data-[closed]:opacity-0 data-[enter]:duration-100 data-[leave]:duration-75 data-[enter]:ease-out data-[leave]:ease-in overflow-hidden"
                    >
                      {/* Header */}
                      <div className="px-4 py-2.5 border-b border-white/10">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                          Your Selections
                        </p>
                      </div>

                      {currentSelections.length === 0 ? (
                        <p className="px-4 py-3 text-sm text-gray-500 italic">
                          No selections yet
                        </p>
                      ) : (
                        <div className="py-1">
                          {currentSelections.map((item) => {
                            const name = allRestaurants[item]?.name ?? 'Custom entry';
                            return (
                              <MenuItem key={item}>
                                <div className="flex items-center justify-between px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors group">
                                  <button
                                    onClick={() => setDetailId(item)}
                                    className="truncate flex-1 text-left"
                                  >
                                    {name}
                                  </button>
                                  <button
                                    onClick={() => dispatch(removeUserSelection(item))}
                                    className="ml-3 shrink-0 text-gray-500 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                                    aria-label={`Remove ${name}`}
                                  >
                                    ✕
                                  </button>
                                </div>
                              </MenuItem>
                            );
                          })}
                        </div>
                      )}

                      {/* Footer — link to Choose page */}
                      <div className="border-t border-white/10">
                        <Link
                          to={`/choose/${userId}`}
                          className="block px-4 py-2.5 text-xs text-indigo-400 hover:text-indigo-300 hover:bg-gray-700 transition-colors font-medium"
                        >
                          Go to Choose page →
                        </Link>
                      </div>
                    </MenuItems>
                  </Menu>

                  {/* ── Profile dropdown ──────────────────────── */}
                  <Menu as="div" className="relative ml-1">
                    <MenuButton className="flex items-center rounded-full bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-gray-800">
                      <span className="sr-only">Open user menu</span>
                      <img alt="" src={userAvatar} className="h-8 w-8 rounded-full" />
                    </MenuButton>

                    <MenuItems
                      transition
                      className="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-lg bg-gray-800 ring-1 ring-white/10 shadow-xl transition focus:outline-none data-[closed]:scale-95 data-[closed]:opacity-0 data-[enter]:duration-100 data-[leave]:duration-75 data-[enter]:ease-out data-[leave]:ease-in overflow-hidden py-1"
                    >
                      {userNavigation.map((item) => (
                        <MenuItem key={item.name}>
                          <Link
                            to={item.link}
                            className="block px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors"
                          >
                            {item.name}
                          </Link>
                        </MenuItem>
                      ))}
                    </MenuItems>
                  </Menu>
                </div>
              </div>

              {/* Mobile hamburger */}
              <div className="-mr-2 flex md:hidden">
                <DisclosureButton className="group relative inline-flex items-center justify-center rounded-md bg-gray-800 p-2 text-gray-400 hover:bg-gray-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-gray-800">
                  <span className="absolute -inset-0.5" />
                  <span className="sr-only">Open main menu</span>
                  <Bars3Icon aria-hidden="true" className="block h-6 w-6 group-data-[open]:hidden" />
                  <XMarkIcon aria-hidden="true" className="hidden h-6 w-6 group-data-[open]:block" />
                </DisclosureButton>
              </div>
            </div>
          </div>
        </Disclosure>

        <header className="bg-white shadow">
          <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8 flex items-center gap-4 flex-wrap">
            <h1 className="text-xl font-bold tracking-tight text-gray-900 shrink-0">Selections</h1>
            {currentSelections.length === 0 ? (
              <span className="text-sm text-gray-400 italic">No selections yet — add one from the Search page.</span>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                {currentSelections.map((id) => {
                  const name = allRestaurants[id]?.name ?? 'Custom entry';
                  return (
                    <span
                      key={id}
                      className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-100 text-indigo-700 text-sm font-medium"
                    >
                      {name}
                      <button
                        onClick={() => dispatch(removeUserSelection(id))}
                        className="text-indigo-400 hover:text-indigo-700 leading-none transition-colors"
                        aria-label={`Remove ${name}`}
                      >
                        ✕
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </header>
      </div>
      <Outlet />

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
