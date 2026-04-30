import { useState } from "react";
import { Link } from "react-router-dom";
import { useDispatch } from "react-redux";
import { restaurants } from "../tempData/restaurants";
import { addUserSelection, updateUserFavorites } from "../redux/slices/userInfoSlice";
import useCurrentUser from "../hooks/useCurrentUser";
import StarRating from "../components/star-rating/star-rating.component";
import getMostRecentDate from "../utils/getMostRecentDate";

const PRICE_LABELS = { 1: '$', 2: '$$', 3: '$$$', 4: '$$$$' };

const cuisineTypes = [...new Set(Object.values(restaurants).map(r => r.type))].sort();

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [cuisineFilter, setCuisineFilter] = useState("All");

  const currentUser = useCurrentUser();
  const dispatch = useDispatch();

  const results = Object.entries(restaurants).filter(([, r]) => {
    const matchesQuery =
      r.name.toLowerCase().includes(query.toLowerCase()) ||
      r.type.toLowerCase().includes(query.toLowerCase());
    const matchesCuisine = cuisineFilter === "All" || r.type === cuisineFilter;
    return matchesQuery && matchesCuisine;
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex gap-4 mb-6">
        <input
          type="text"
          placeholder="Search by name or cuisine..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6 px-3"
        />
        <select
          value={cuisineFilter}
          onChange={(e) => setCuisineFilter(e.target.value)}
          className="rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm px-3"
        >
          <option value="All">All cuisines</option>
          {cuisineTypes.map(type => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </div>

      {results.length === 0 && (
        <p className="text-gray-500 text-sm">No restaurants match your search.</p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {results.map(([id, r]) => {
          const isFavorited = currentUser.favorites.includes(Number(id)) || currentUser.favorites.includes(id);
          const isSelected = currentUser.selections.includes(Number(id)) || currentUser.selections.includes(id);
          return (
            <div key={id} className="flex flex-col rounded-lg border border-gray-200 p-4 shadow-sm bg-white">
              <div className="flex justify-between items-start">
                <div className="min-w-0">
                  <Link to={`/restaurant/${id}`} className="text-indigo-600 font-semibold hover:underline">
                    {r.name}
                  </Link>
                  {getMostRecentDate(currentUser.accepted, id) && (
                    <span className="ml-2 text-xs text-gray-400 whitespace-nowrap">
                      Last chosen {getMostRecentDate(currentUser.accepted, id)}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => dispatch(updateUserFavorites({ restaurantId: id, userId: currentUser.id }))}
                  className={`text-xl shrink-0 ${isFavorited ? 'text-red-500' : 'text-gray-300'}`}
                >
                  &#9829;
                </button>
              </div>
              <p className="text-sm text-gray-500 mt-1">{r.type} · {PRICE_LABELS[r.price]} · Opens {r.hours}</p>
              <div className="flex items-center gap-1 mt-1">
                <StarRating rating={r.rating} />
              </div>
              <div className="mt-auto pt-3">
                <div className="flex gap-2 text-xs text-gray-500 min-h-[1.25rem]">
                  {r.takeout && <span className="bg-gray-100 px-2 py-0.5 rounded">Takeout</span>}
                  {r.delivery && <span className="bg-gray-100 px-2 py-0.5 rounded">Delivery</span>}
                </div>
                <button
                  onClick={() => dispatch(addUserSelection(id))}
                  disabled={isSelected}
                  className="mt-3 w-full rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isSelected ? 'Added to selections' : 'Add to selections'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
