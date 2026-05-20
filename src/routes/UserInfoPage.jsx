import { useDispatch, useSelector } from "react-redux";
import { useState } from "react";

import {
  setUserData,
  updateUserFavorites,
  addAddress,
  updateAddress,
  removeAddress,
} from "../redux/slices/userInfoSlice";
import { logoutUser, patchAuthUser } from "../redux/slices/authSlice";
import { fileToDownscaledAvatarDataUrl } from "../utils/downscaleAvatar";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import getMostRecentDate from "../utils/getMostRecentDate";
import useCurrentUser from "../hooks/useCurrentUser";
import RestaurantReviewModal from "../components/RestaurantReviewModal";
import RatingDisplay from "../components/RatingDisplay";
import { PRICE_LABELS } from "../utils/restaurantConstants";

const RANK_STYLES = [
  'bg-yellow-400 text-yellow-900',
  'bg-gray-300 text-gray-700',
  'bg-orange-300 text-orange-900',
  'bg-gray-100 text-gray-500',
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

const StatCard = ({ label, value, sub }) => (
  <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm text-center">
    <p className="text-3xl font-bold text-orange-600">{value}</p>
    <p className="text-sm font-medium text-gray-700 mt-1">{label}</p>
    {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

const UserInfoPage = () => {
  const userInfo = useCurrentUser();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const allRestaurants = customRestaurants;

  const [username, setUsername] = useState('');
  const [usernameError, setUsernameError] = useState('');
  const [selectedRestaurantId, setSelectedRestaurantId] = useState(null);

  const isAuthenticated = useSelector((state) => state.auth.status === 'authenticated');
  // Empty-state suppression: hide "No history yet" until loadUserData
  // lands so refreshes don't briefly flash the prompt before the
  // user's real history shows up.
  const isUnauthenticated = useSelector((state) => state.auth.status === 'unauthenticated');
  const isDataLoaded      = useSelector((state) => state.userInfo.isDataLoaded);
  const isDataPending     = !isUnauthenticated && !isDataLoaded;

  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameSuccess, setUsernameSuccess] = useState(false);

  // Avatar — source of truth lives in auth.user (populated from /api/auth/me
  // on session restore). Local state just covers the in-flight upload + the
  // last error message.
  const avatarUrl = useSelector((state) => state.auth.user?.avatarUrl ?? null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError,  setAvatarError]  = useState('');

  const handleAvatarChange = async (e) => {
    const file = e.target.files?.[0];
    // Reset the input value so picking the same file twice still triggers
    // change (browsers suppress duplicate selections otherwise).
    e.target.value = '';
    if (!file) return;
    setAvatarError('');
    setAvatarSaving(true);
    try {
      const dataUrl = await fileToDownscaledAvatarDataUrl(file);
      const { user } = await api.users.setAvatar(dataUrl);
      dispatch(patchAuthUser({ avatarUrl: user.avatarUrl }));
    } catch (err) {
      setAvatarError(err?.message ?? 'Could not save avatar.');
    } finally {
      setAvatarSaving(false);
    }
  };

  const handleAvatarRemove = async () => {
    setAvatarError('');
    setAvatarSaving(true);
    try {
      const { user } = await api.users.setAvatar(null);
      dispatch(patchAuthUser({ avatarUrl: user.avatarUrl }));
    } catch (err) {
      setAvatarError(err?.message ?? 'Could not remove avatar.');
    } finally {
      setAvatarSaving(false);
    }
  };

  // Dietary tags — Redux is the source of truth; local state covers
  // mid-edit (typing a new tag) and the save spinner.
  const dietaryTags = userInfo.dietaryTags ?? [];
  const [newTag, setNewTag] = useState('');
  const [tagsSaving, setTagsSaving] = useState(false);
  const [tagsError,  setTagsError]  = useState('');
  const RECOMMENDED_TAGS = [
    'vegetarian', 'vegan', 'gluten-free', 'halal', 'kosher',
    'dairy-free', 'nut-allergy', 'shellfish-allergy', 'pescatarian',
  ];

  const persistDietaryTags = async (nextTags) => {
    setTagsError('');
    setTagsSaving(true);
    try {
      const { user } = await api.users.setDietaryTags(nextTags);
      // Fold the server's normalized list (lowercased, deduped, ordered)
      // back into Redux — single source of truth for downstream displays.
      dispatch(setUserData({ ...userInfo, dietaryTags: user.dietaryTags }));
    } catch (err) {
      setTagsError(err.message ?? 'Could not save tags.');
    } finally {
      setTagsSaving(false);
    }
  };

  const handleAddTag = async (raw) => {
    const cleaned = raw.trim().toLowerCase();
    if (!cleaned || dietaryTags.includes(cleaned)) {
      setNewTag('');
      return;
    }
    if (dietaryTags.length >= 10) {
      setTagsError('Maximum 10 dietary tags');
      return;
    }
    await persistDietaryTags([...dietaryTags, cleaned]);
    setNewTag('');
  };

  const handleRemoveTag = (t) => {
    persistDietaryTags(dietaryTags.filter((x) => x !== t));
  };

  // Address book — replaces the single defaultAddress field. UI state
  // covers the "add new" inline form, the per-row inline-edit form, and
  // a small toast-style success indicator. Persistent address list lives
  // in Redux (userInfo.addresses); these state vars are pure ephemera.
  const addresses = userInfo.addresses ?? [];
  const [newLabel,   setNewLabel]   = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [addError,   setAddError]   = useState('');
  const [addSaving,  setAddSaving]  = useState(false);
  // Per-row edit/delete state. `editingId` of null means the inline-add
  // form is the one accepting input; non-null routes input to the
  // matching row's edit form. Only one row can be in edit mode at a time
  // — simpler UI, easier to reason about.
  const [editingId,     setEditingId]     = useState(null);
  const [editLabel,     setEditLabel]     = useState('');
  const [editAddress,   setEditAddress]   = useState('');
  const [editError,     setEditError]     = useState('');
  const [editSaving,    setEditSaving]    = useState(false);
  const [rowActioning,  setRowActioning]  = useState(null); // id of row mid set-default / delete

  // ── Account deletion ──────────────────────────────────────
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  // Data-export state (used both from the delete dialog and a standalone
  // button in the danger zone). Separate from the deletion flow so a user
  // can pull their data without triggering the delete confirm modal.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const handleExportData = async () => {
    setExporting(true);
    setExportError('');
    try { await api.users.exportData(); }
    catch (err) { setExportError(err?.message ?? 'Could not export data.'); }
    finally { setExporting(false); }
  };
  // Opt-in retraction of reviews. Off by default — the default delete-account
  // behavior anonymizes (userId → null) so the community keeps the rating
  // data. Users who want their public contributions fully removed can flip
  // this on and the server deletes the review rows before the FK cascade.
  const [retractReviews, setRetractReviews] = useState(false);

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== userInfo.username) return;
    setDeleteLoading(true);
    setDeleteError('');
    try {
      await api.users.deleteAccount({ retractReviews });
      dispatch(logoutUser());
      navigate('/');
    } catch (err) {
      setDeleteError(err.message ?? 'Could not delete account.');
      setDeleteLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = username.trim();
    if (!trimmed) return;
    setUsernameError('');
    setUsernameSuccess(false);
    setUsernameSaving(true);
    try {
      const { user } = await api.users.updateProfile({ username: trimmed });
      dispatch(setUserData({ ...userInfo, id: user.id, email: user.email, username: user.username }));
      setUsername('');
      setUsernameSuccess(true);
      setTimeout(() => setUsernameSuccess(false), 3000);
    } catch (err) {
      setUsernameError(err.message ?? 'Could not update username.');
    } finally {
      setUsernameSaving(false);
    }
  };

  // ── Address book handlers ────────────────────────────────────
  // Pattern: try the server first, then dispatch into Redux on success.
  // The server enforces the "exactly one default" invariant inside a
  // transaction, so the slice reducers below can just trust whatever
  // comes back.

  const handleAddAddress = async (e) => {
    e.preventDefault();
    const label   = newLabel.trim();
    const address = newAddress.trim();
    if (!label || !address) return;
    setAddError('');
    setAddSaving(true);
    try {
      // First entry auto-defaults server-side, so no need to pass
      // isDefault here unless the user explicitly chose to promote.
      const { address: created } = await api.users.createAddress({ label, address });
      dispatch(addAddress(created));
      setNewLabel('');
      setNewAddress('');
    } catch (err) {
      setAddError(err.message ?? 'Could not save address.');
    } finally {
      setAddSaving(false);
    }
  };

  const beginEdit = (entry) => {
    setEditingId(entry.id);
    setEditLabel(entry.label);
    setEditAddress(entry.address);
    setEditError('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditLabel('');
    setEditAddress('');
    setEditError('');
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    const label   = editLabel.trim();
    const address = editAddress.trim();
    if (!label || !address) return;
    setEditError('');
    setEditSaving(true);
    try {
      const { address: updated } = await api.users.updateAddress(editingId, { label, address });
      dispatch(updateAddress(updated));
      cancelEdit();
    } catch (err) {
      setEditError(err.message ?? 'Could not update address.');
    } finally {
      setEditSaving(false);
    }
  };

  const handleSetDefault = async (entry) => {
    if (entry.isDefault) return;
    setRowActioning(entry.id);
    try {
      const { address: updated } = await api.users.updateAddress(entry.id, { isDefault: true });
      dispatch(updateAddress(updated));
    } catch {
      // Non-fatal; the row stays as it was. Visible failure surface is
      // small — the "default" pin just doesn't move. Could surface a
      // toast later if useful.
    } finally {
      setRowActioning(null);
    }
  };

  const handleDeleteAddress = async (entry) => {
    setRowActioning(entry.id);
    try {
      await api.users.deleteAddress(entry.id);
      dispatch(removeAddress(entry.id));
      if (editingId === entry.id) cancelEdit();
    } catch {
      /* non-fatal — row remains visible */
    } finally {
      setRowActioning(null);
    }
  };

  const flipCount = userInfo.flipCount ?? 0;
  const acceptanceCount = userInfo.accepted.length;
  const acceptanceRate = flipCount > 0
    ? `${Math.round((acceptanceCount / flipCount) * 100)}%`
    : '—';

  const top4 = getTop4MostChosen(userInfo.accepted);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-start">

        {/* ── LEFT: Profile + Stats ────────────────────────────── */}
        <div className="min-w-0 flex flex-col gap-8">

          {/* Profile form */}
          <form onSubmit={handleSubmit}>
            <div className="border-b border-gray-900/10 pb-8">
              <h2 className="text-base font-semibold leading-7 text-gray-900">Profile</h2>
              <p className="mt-1 text-sm leading-6 text-gray-600">
                Update your username. Leave blank to keep the current value.
              </p>

              {/* Avatar editor — picks a file, downscales client-side, and
                  posts the resulting data URL to /api/users/me/avatar. The
                  preview reads from auth.user so it updates in lockstep
                  with the navbar avatar after a save. */}
              <div className="mt-6 flex items-center gap-4">
                <div className="h-16 w-16 rounded-full overflow-hidden bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center shadow-brand-sm shrink-0">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="Your avatar" className="h-full w-full object-cover" />
                  ) : (
                    <svg className="h-10 w-10 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
                    </svg>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3 flex-wrap">
                    {/* The label-wrapped input pattern lets us style the
                        affordance like a real button while keeping the
                        native file picker behavior + a11y. */}
                    <label className="inline-flex items-center rounded-md bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-orange-400 cursor-pointer disabled:opacity-40">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp"
                        onChange={handleAvatarChange}
                        disabled={avatarSaving}
                        className="sr-only"
                      />
                      {avatarSaving ? 'Saving…' : avatarUrl ? 'Change' : 'Upload'}
                    </label>
                    {avatarUrl && (
                      <button
                        type="button"
                        onClick={handleAvatarRemove}
                        disabled={avatarSaving}
                        className="text-sm font-medium text-gray-500 hover:text-red-500 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-gray-400">PNG, JPEG, GIF, or WebP. Auto-resized to 256×256.</p>
                  {avatarError && <p className="mt-1 text-xs text-red-500">{avatarError}</p>}
                </div>
              </div>

              <div className="mt-6">
                <label htmlFor="username" className="block text-sm font-medium leading-6 text-gray-900 mb-1">
                  Username
                </label>
                <div className={`flex rounded-md shadow-sm ring-1 ring-inset transition-colors ${
                  usernameError ? 'ring-red-400 focus-within:ring-red-500' : 'ring-gray-300 focus-within:ring-2 focus-within:ring-orange-500'
                }`}>
                  <input
                    id="username"
                    type="text"
                    autoComplete="username"
                    placeholder={userInfo.username}
                    value={username}
                    onChange={(e) => { setUsername(e.target.value); setUsernameError(''); }}
                    className="block flex-1 border-0 bg-transparent py-1.5 pl-3 text-gray-900 placeholder:text-gray-400 focus:ring-0 sm:text-sm sm:leading-6"
                  />
                </div>
                {usernameError   && <p className="mt-1 text-xs text-red-500">{usernameError}</p>}
                {usernameSuccess && <p className="mt-1 text-xs text-green-600">Username updated!</p>}
              </div>
            </div>

            <div className="mt-5 flex items-center gap-x-4">
              <button
                type="button"
                onClick={() => { setUsername(''); setUsernameError(''); }}
                className="text-sm font-semibold leading-6 text-gray-900 hover:text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!username.trim() || usernameSaving}
                className="rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500"
              >
                {usernameSaving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </form>

          {/* Dietary tags — surfaced in group + trip member rows so meal
              planners can see restrictions at a glance. Free-form, but the
              recommended-set chips below cover the common cases. */}
          <div className="border-b border-gray-900/10 pb-8">
            <h2 className="text-base font-semibold leading-7 text-gray-900">Dietary tags</h2>
            <p className="mt-1 text-sm leading-6 text-gray-600">
              Shown next to your name in groups and trips. Max 10 tags.
            </p>

            {dietaryTags.length > 0 && (
              <ul className="mt-4 flex flex-wrap gap-2">
                {dietaryTags.map((t) => (
                  <li key={t} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-100 px-2.5 py-1 text-xs text-emerald-700">
                    {t}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(t)}
                      disabled={tagsSaving}
                      aria-label={`Remove ${t}`}
                      className="text-emerald-500 hover:text-red-500 disabled:opacity-40"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Recommended-set quick-adds. Filtered to those the user
                hasn't already added so the user never sees a chip that
                no-ops on click. */}
            {RECOMMENDED_TAGS.filter((t) => !dietaryTags.includes(t)).length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-gray-500 mb-1.5">Quick-add</p>
                <div className="flex flex-wrap gap-1.5">
                  {RECOMMENDED_TAGS.filter((t) => !dietaryTags.includes(t)).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => handleAddTag(t)}
                      disabled={tagsSaving || dietaryTags.length >= 10}
                      className="rounded-full border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:border-orange-400 hover:bg-orange-50 disabled:opacity-40"
                    >
                      + {t}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <form
              onSubmit={(e) => { e.preventDefault(); handleAddTag(newTag); }}
              className="mt-4 flex items-center gap-2"
            >
              <input
                type="text"
                value={newTag}
                onChange={(e) => { setNewTag(e.target.value); setTagsError(''); }}
                placeholder="Custom tag (e.g. low-fodmap)"
                maxLength={40}
                disabled={tagsSaving || dietaryTags.length >= 10}
                className="flex-1 min-w-0 rounded-md border-0 ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-orange-500 px-3 py-1.5 text-sm placeholder:text-gray-400 disabled:opacity-40"
              />
              <button
                type="submit"
                disabled={!newTag.trim() || tagsSaving || dietaryTags.length >= 10}
                className="rounded-md bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-400 disabled:opacity-40"
              >
                {tagsSaving ? 'Saving…' : 'Add'}
              </button>
            </form>

            {tagsError && <p className="mt-2 text-xs text-red-500">{tagsError}</p>}
            {dietaryTags.length >= 10 && !tagsError && (
              <p className="mt-2 text-xs text-gray-400">You've reached the 10-tag limit.</p>
            )}
          </div>

          {/* Address book — replaces the older single "Default search
              address" field. Users can save multiple labeled locations
              (Home, Work, Mom's, etc.); the row marked as default drives
              the Search-page prefill. The first entry auto-defaults; any
              entry can be promoted to default after that. Limit is 10
              entries (enforced server-side; UI hint when at capacity). */}
          <div className="border-b border-gray-900/10 pb-8">
            <h2 className="text-base font-semibold leading-7 text-gray-900">Address book</h2>
            <p className="mt-1 text-sm leading-6 text-gray-600">
              Save locations you search from often (Home, Work, etc.). The
              one marked <em>default</em> auto-fills the Search-page
              location box.
            </p>

            {addresses.length > 0 && (
              <ul className="mt-5 flex flex-col gap-2">
                {addresses.map((entry) => (
                  <li
                    key={entry.id}
                    className={`rounded-lg border p-3 transition-colors ${
                      entry.isDefault ? 'border-orange-300 bg-orange-50/40' : 'border-gray-200 bg-white'
                    }`}
                  >
                    {editingId === entry.id ? (
                      <form onSubmit={handleSaveEdit} className="flex flex-col gap-2">
                        <input
                          type="text"
                          value={editLabel}
                          onChange={(e) => { setEditLabel(e.target.value); setEditError(''); }}
                          placeholder="(e.g. Home)"
                          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                        />
                        <input
                          type="text"
                          value={editAddress}
                          onChange={(e) => { setEditAddress(e.target.value); setEditError(''); }}
                          placeholder="Address or zip code"
                          autoComplete="street-address"
                          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                        />
                        {editError && <p className="text-xs text-red-500">{editError}</p>}
                        <div className="flex items-center gap-2 mt-1">
                          <button
                            type="submit"
                            disabled={!editLabel.trim() || !editAddress.trim() || editSaving}
                            className="rounded-md bg-orange-500 px-3 py-1 text-xs font-semibold text-white hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {editSaving ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="text-xs font-medium text-gray-500 hover:text-gray-700"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-gray-900 truncate">{entry.label}</p>
                            {entry.isDefault && (
                              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-orange-200 text-orange-800">
                                Default
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-500 truncate">{entry.address}</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {!entry.isDefault && (
                            <button
                              type="button"
                              onClick={() => handleSetDefault(entry)}
                              disabled={rowActioning === entry.id}
                              className="rounded px-2 py-1 text-xs font-medium text-orange-600 hover:bg-orange-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Set default
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => beginEdit(entry)}
                            disabled={rowActioning === entry.id}
                            className="rounded px-2 py-1 text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteAddress(entry)}
                            disabled={rowActioning === entry.id}
                            className="rounded px-2 py-1 text-xs font-medium text-red-500 hover:text-red-700 hover:bg-red-50 disabled:opacity-40"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* Inline-add form — hidden once the user hits the cap. The
                server-enforced limit is 10; we mirror it client-side so
                the user gets a friendly hint instead of a 400. */}
            {addresses.length < 10 ? (
              <form onSubmit={handleAddAddress} className="mt-5">
                <p className="text-sm font-medium text-gray-700 mb-2">
                  {addresses.length === 0 ? 'Add your first address' : 'Add another address'}
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={newLabel}
                    onChange={(e) => { setNewLabel(e.target.value); setAddError(''); }}
                    placeholder="(e.g. Home)"
                    maxLength={64}
                    className="sm:w-32 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                  <input
                    type="text"
                    value={newAddress}
                    onChange={(e) => { setNewAddress(e.target.value); setAddError(''); }}
                    placeholder="Address or zip code"
                    autoComplete="street-address"
                    maxLength={256}
                    className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                  <button
                    type="submit"
                    disabled={!newLabel.trim() || !newAddress.trim() || addSaving}
                    className="rounded-md bg-orange-500 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {addSaving ? 'Saving…' : 'Add'}
                  </button>
                </div>
                {addError && <p className="mt-1 text-xs text-red-500">{addError}</p>}
              </form>
            ) : (
              <p className="mt-5 text-xs text-gray-400 italic">
                You've reached the 10-address limit — delete one to add another.
              </p>
            )}
          </div>
        </div>

        {/* ── RIGHT: Top 4 most chosen + Stats ─────────────────── */}
        <div className="flex flex-col gap-8">

          {/* Top 4 picks — wrapped in a single block so the column's
              `gap-8` only applies between Top 4 and the Stats panel,
              not between the heading and its cards. */}
          <div>
          <h2 className="text-2xl font-bold text-gray-900 mb-1">Top Picks</h2>
          <p className="text-sm text-gray-500 mb-4">Your 4 most chosen restaurants</p>

          {isDataPending && top4.length === 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-32 rounded-lg bg-gray-100 animate-pulse" />
              ))}
            </div>
          ) : top4.length === 0 ? (
            <p className="text-gray-500 text-sm italic">
              No history yet. Accept a restaurant from the coin flip to get started.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {top4.map(({ id, count, rank }) => {
                const restaurant = allRestaurants[id];
                if (!restaurant) return null;

                const reviews = userInfo.reviews[id] || [];
                const personalRating =
                  reviews.length > 0
                    ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length
                    : null;
                const isFavorited = userInfo.favorites.map(String).includes(String(id));

                return (
                  // flex-col + h-full lets `mt-auto` on the button push it to
                  // the bottom of the card. The 2-column grid already gives
                  // each card the same height (align-items: stretch), so once
                  // the buttons all anchor to the bottom they line up across
                  // a row regardless of how much content sits above.
                  <div
                    key={id}
                    className="relative flex flex-col h-full rounded-lg border border-gray-200 p-4 shadow-sm bg-white transition-all duration-150 hover:shadow-md hover:border-orange-300 hover:bg-orange-50"
                  >
                    <span className={`absolute -top-2.5 -left-2.5 w-10 h-6 rounded-full text-[11px] font-black flex items-center justify-center shadow-sm ${RANK_STYLES[rank - 1]}`}>
                      {RANK_LABELS[rank - 1]}
                    </span>
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0">
                        <span className="text-orange-600 font-semibold block truncate">{restaurant.name}</span>
                        {getMostRecentDate(userInfo.accepted, id) && (
                          <span className="text-xs text-gray-400">
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

                    <div className="mt-1">
                      <RatingDisplay
                        restaurantId={id}
                        googleRating={restaurant.rating ?? null}
                        personalRating={personalRating}
                        personalReviews={reviews}
                        restaurantName={restaurant.name}
                      />
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

                    {/* Wrapper carries `mt-auto` (push to bottom of the flex
                        column) and the breathing-room gap above the button.
                        Putting the auto-margin on a wrapper instead of the
                        button itself avoids inflating the button's clickable
                        area. Cards in the same row line up regardless of
                        their above-the-button content (reviews-count line,
                        takeout/delivery badges, last-chosen string). */}
                    <div className="mt-auto pt-3">
                      <button
                        type="button"
                        onClick={() => setSelectedRestaurantId(id)}
                        className="w-full rounded-md bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-500"
                      >
                        See Reviews
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </div>{/* /Top Picks block */}

          {/* Stats — moved here so it sits underneath Top 4 and to the
              right of the address book. Keeps the visual rhythm of the
              two-column layout: profile info on the left, history/stats
              on the right. */}
          <div>
            <h2 className="text-base font-semibold leading-7 text-gray-900 mb-1">Your Stats</h2>
            <p className="text-sm text-gray-500 mb-4">How indecisive are you?</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StatCard label="Total Flips & Spins" value={flipCount} />
              <StatCard label="Times Accepted" value={acceptanceCount} />
              <StatCard
                label="Acceptance Rate"
                value={acceptanceRate}
                sub={flipCount > 0 ? `${acceptanceCount} of ${flipCount}` : 'No flips yet'}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Danger zone ─────────────────────────────────── */}
      {isAuthenticated && (
        <div className="mt-12 border-t border-red-100 pt-8">
          <h2 className="text-base font-semibold text-red-600 mb-1">Danger Zone</h2>
          <p className="text-sm text-gray-500 mb-4">Permanently delete your account and all associated data. This cannot be undone.</p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleExportData}
              disabled={exporting}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              {exporting ? 'Preparing…' : 'Download my data'}
            </button>
            <button
              onClick={() => {
                setShowDeleteModal(true);
                setDeleteConfirmText('');
                setDeleteError('');
                setRetractReviews(false); // Default state every time the modal opens
              }}
              className="rounded-md border border-red-300 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 transition-colors"
            >
              Delete account
            </button>
          </div>
          {exportError && <p className="mt-2 text-xs text-red-500">{exportError}</p>}
        </div>
      )}

      {/* ── Delete account modal ─────────────────────────── */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 flex flex-col gap-4">
            <div>
              <h2 className="text-base font-bold text-gray-900">Delete your account?</h2>
              <p className="text-sm text-gray-500 mt-1">
                This will permanently delete your account, favorites, options, history, and group memberships. This cannot be undone.
              </p>
              <p className="text-xs text-gray-400 mt-2">
                Your reviews will remain on each restaurant's page but appear as <em>[deleted user]</em>, so the community keeps the rating data. Check the box below to remove them too.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Type <strong>{userInfo.username}</strong> to confirm
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder={userInfo.username}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                autoFocus
              />
            </div>
            <label className="flex items-start gap-2 text-xs text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={retractReviews}
                onChange={(e) => setRetractReviews(e.target.checked)}
                className="mt-0.5 rounded border-gray-300 text-red-600 focus:ring-red-500"
              />
              <span>
                <strong>Also remove my reviews.</strong> The ratings I left will be deleted entirely and no longer counted in community ratings.
              </span>
            </label>
            {/* In-context download nudge — same handler as the danger-zone
                button, just placed where users will see it right before
                clicking Delete. The button is text-style so it doesn't
                compete with the Delete CTA's visual weight. */}
            <div className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600 flex items-center justify-between gap-2">
              <span>Want a copy of your data first?</span>
              <button
                type="button"
                onClick={handleExportData}
                disabled={exporting}
                className="font-semibold text-orange-600 hover:text-orange-700 disabled:opacity-40"
              >
                {exporting ? 'Preparing…' : 'Download'}
              </button>
            </div>
            {deleteError && <p className="text-xs text-red-500">{deleteError}</p>}
            {exportError && <p className="text-xs text-red-500">{exportError}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={
                  // The username must exist AND match. Without the
                  // first clause, an empty userInfo.username (e.g.
                  // mid-session-restore before identity hydrates)
                  // makes empty input "match" empty username and
                  // the button enables on first render — the
                  // opposite of what we want for a destructive
                  // action. Explicit non-empty guard locks the
                  // button until both sides are populated and
                  // exactly equal.
                  !userInfo.username
                  || deleteConfirmText !== userInfo.username
                  || deleteLoading
                }
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {deleteLoading ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}

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
