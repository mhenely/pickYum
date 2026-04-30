import { useDispatch, useSelector } from "react-redux";
import { useState } from "react";

import { updateUserInfo, updateUserFavorites } from "../redux/slices/userInfoSlice";
import getMostRecentDate from "../utils/getMostRecentDate";
import useCurrentUser from "../hooks/useCurrentUser";
import { users } from "../tempData/users";
import { restaurants } from "../tempData/restaurants";
import RestaurantReviewModal from "../components/RestaurantReviewModal";
import StarRating from "../components/star-rating/star-rating.component";

const PRICE_LABELS = { 1: '$', 2: '$$', 3: '$$$', 4: '$$$$' };

const RANK_STYLES = [
  'bg-yellow-400 text-yellow-900',   // 1st — gold
  'bg-gray-300 text-gray-700',       // 2nd — silver
  'bg-orange-300 text-orange-900',   // 3rd — bronze
  'bg-gray-100 text-gray-500',       // 4th — plain
];

const RANK_LABELS = ['1st', '2nd', '3rd', '4th'];

const getTop4MostChosen = (accepted) => {
  const data = {};
  accepted.forEach(({ restaurantId, date }) => {
    const key = String(restaurantId);
    if (!data[key]) data[key] = { count: 0, latestDate: new Date(0) };
    data[key].count += 1;
    const d = new Date(date);
    if (d > data[key].latestDate) data[key].latestDate = d;
  });
  return Object.entries(data)
    .sort(([, a], [, b]) =>
      b.count !== a.count ? b.count - a.count : b.latestDate - a.latestDate
    )
    .slice(0, 4)
    .map(([id, { count }], index) => ({ id, count, rank: index + 1 }));
};

const UserInfoPage = () => {
  const userInfo = useCurrentUser();
  const dispatch = useDispatch();
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const allRestaurants = { ...restaurants, ...customRestaurants };

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [selectedRestaurantId, setSelectedRestaurantId] = useState(null);

  const validate = () => {
    const errs = {};

    if (username.trim()) {
      const taken = users.some(
        (u) => u.id !== userInfo.id && u.username.toLowerCase() === username.trim().toLowerCase()
      );
      if (taken) errs.username = 'That username is already taken.';
    }

    if (email.trim()) {
      const taken = users.some(
        (u) => u.id !== userInfo.id && u.email.toLowerCase() === email.trim().toLowerCase()
      );
      if (taken) errs.email = 'That email address is already in use.';
    }

    if (password) {
      if (password !== confirmPassword) errs.password = 'Passwords do not match.';
    }

    return errs;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    dispatch(updateUserInfo({
      id: userInfo.id,
      ...(username.trim() && { username: username.trim() }),
      ...(email.trim() && { email: email.trim() }),
      ...(password && { password }),
    }));
    setUsername('');
    setEmail('');
    setPassword('');
    setConfirmPassword('');
  };

  const top4 = getTop4MostChosen(userInfo.accepted);

  const field = (label, id, inputProps, error) => (
    <div>
      <label htmlFor={id} className="block text-sm font-medium leading-6 text-gray-900 mb-1">
        {label}
      </label>
      <div className={`flex rounded-md shadow-sm ring-1 ring-inset transition-colors ${
        error ? 'ring-red-400 focus-within:ring-red-500' : 'ring-gray-300 focus-within:ring-2 focus-within:ring-indigo-600'
      }`}>
        <input
          id={id}
          className="block flex-1 border-0 bg-transparent py-1.5 pl-3 text-gray-900 placeholder:text-gray-400 focus:ring-0 sm:text-sm sm:leading-6"
          {...inputProps}
        />
      </div>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="grid grid-cols-2 gap-10 items-start">

        {/* ── LEFT: Profile form ────────────────────────────────── */}
        <form onSubmit={handleSubmit} className="min-w-0">
          <div className="border-b border-gray-900/10 pb-10">
            <h2 className="text-base font-semibold leading-7 text-gray-900">Profile</h2>
            <p className="mt-1 text-sm leading-6 text-gray-600">
              Update your account information. Leave a field blank to keep its current value.
            </p>

            <div className="mt-8 flex flex-col gap-6">

              {/* Username */}
              {field(
                'Username',
                'username',
                {
                  type: 'text',
                  autoComplete: 'username',
                  placeholder: userInfo.username,
                  value: username,
                  onChange: (e) => { setUsername(e.target.value); setErrors((p) => ({ ...p, username: '' })); },
                },
                errors.username
              )}

              {/* Email */}
              {field(
                'Email address',
                'email',
                {
                  type: 'email',
                  autoComplete: 'email',
                  placeholder: userInfo.email,
                  value: email,
                  onChange: (e) => { setEmail(e.target.value); setErrors((p) => ({ ...p, email: '' })); },
                },
                errors.email
              )}

              {/* New Password */}
              {field(
                'New Password',
                'password',
                {
                  type: 'password',
                  autoComplete: 'new-password',
                  placeholder: '••••••••',
                  value: password,
                  onChange: (e) => { setPassword(e.target.value); setErrors((p) => ({ ...p, password: '' })); },
                },
                null
              )}

              {/* Confirm Password */}
              {field(
                'Confirm Password',
                'confirm-password',
                {
                  type: 'password',
                  autoComplete: 'new-password',
                  placeholder: '••••••••',
                  value: confirmPassword,
                  onChange: (e) => { setConfirmPassword(e.target.value); setErrors((p) => ({ ...p, password: '' })); },
                },
                errors.password
              )}
            </div>
          </div>

          <div className="mt-6 flex items-center gap-x-4">
            <button
              type="button"
              onClick={() => { setUsername(''); setEmail(''); setPassword(''); setConfirmPassword(''); setErrors({}); }}
              className="text-sm font-semibold leading-6 text-gray-900 hover:text-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              Save Changes
            </button>
          </div>
        </form>

        {/* ── RIGHT: Top 4 most chosen ──────────────────────────── */}
        <div>
          <h2 className="text-2xl font-bold text-gray-900 mb-1">Top Picks</h2>
          <p className="text-sm text-gray-500 mb-4">Your 4 most chosen restaurants</p>

          {top4.length === 0 ? (
            <p className="text-gray-500 text-sm italic">
              No history yet. Accept a restaurant from the coin flip to get started.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {top4.map(({ id, count, rank }) => {
                const restaurant = allRestaurants[id];
                if (!restaurant) return null;

                const reviews = userInfo.reviews[id] || [];
                const avgRating =
                  reviews.length > 0
                    ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length
                    : restaurant.rating ?? 0;
                const isFavorited = userInfo.favorites.map(String).includes(String(id));

                return (
                  <div
                    key={id}
                    className="relative rounded-lg border border-gray-200 p-4 shadow-sm bg-white transition-all duration-150 hover:shadow-md hover:border-indigo-300 hover:bg-indigo-50"
                  >
                    <span className={`absolute -top-2.5 -left-2.5 w-10 h-6 rounded-full text-[11px] font-black flex items-center justify-center shadow-sm ${RANK_STYLES[rank - 1]}`}>
                      {RANK_LABELS[rank - 1]}
                    </span>
                    <div className="flex justify-between items-start">
                      <div className="min-w-0">
                        <span className="text-indigo-600 font-semibold">{restaurant.name}</span>
                        {getMostRecentDate(userInfo.accepted, id) && (
                          <span className="ml-2 text-xs text-gray-400 whitespace-nowrap">
                            Last chosen {getMostRecentDate(userInfo.accepted, id)}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))
                        }
                        className={`text-xl leading-none shrink-0 ${isFavorited ? 'text-red-500' : 'text-gray-300 hover:text-red-300'}`}
                      >
                        &#9829;
                      </button>
                    </div>

                    <p className="text-sm text-gray-500 mt-1">
                      {restaurant.type} · {PRICE_LABELS[restaurant.price]} · Opens {restaurant.hours}
                    </p>

                    <div className="flex items-center gap-1 mt-1">
                      <StarRating rating={avgRating} />
                      {reviews.length > 0 && (
                        <span className="text-xs text-gray-400 ml-1">
                          ({reviews.length} review{reviews.length !== 1 ? 's' : ''})
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between mt-3">
                      <div className="flex gap-2 text-xs text-gray-500">
                        {restaurant.takeout && (
                          <span className="bg-gray-100 px-2 py-0.5 rounded">Takeout</span>
                        )}
                        {restaurant.delivery && (
                          <span className="bg-gray-100 px-2 py-0.5 rounded">Delivery</span>
                        )}
                      </div>
                      <span className="text-xs text-gray-400 italic">
                        Chosen {count}×
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => setSelectedRestaurantId(id)}
                      className="mt-3 w-full rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
                    >
                      See Reviews
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selectedRestaurantId && (
        <RestaurantReviewModal
          readOnly
          restaurant={allRestaurants[selectedRestaurantId]}
          reviews={userInfo.reviews[selectedRestaurantId] || []}
          onClose={() => setSelectedRestaurantId(null)}
        />
      )}
    </div>
  );
};

export default UserInfoPage;
