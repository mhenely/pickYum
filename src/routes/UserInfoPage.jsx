import { useDispatch, useSelector } from "react-redux";
import { useState, useEffect } from "react";
import {
  getNotificationPermission,
  getCurrentSubscription,
  subscribeToPush,
  unsubscribeFromPush,
} from '../lib/pushNotifications';

import {
  setUserData,
  addAddress,
  updateAddress,
  removeAddress,
} from "../redux/slices/userInfoSlice";
import { logoutUser, patchAuthUser } from "../redux/slices/authSlice";
import { fileToDownscaledAvatarDataUrl } from "../utils/downscaleAvatar";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import useCurrentUser from "../hooks/useCurrentUser";
import Button from "../components/ui/Button";

// `view` selects which subset of sections to render. Used by YouPage to
// split this large page across its Account and Preferences tabs without
// duplicating the state and handlers that all the sections share. When
// rendered standalone (e.g. via the legacy /userInfo redirect path) the
// default 'account' view fires.
//   - 'account'     → Profile, Account security, Sign out, Danger Zone
//   - 'preferences' → Dietary tags, Push notifications, Address book
const UserInfoPage = ({ view = 'account' }) => {
  const userInfo = useCurrentUser();
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [usernameError, setUsernameError] = useState('');

  const isAuthenticated = useSelector((state) => state.auth.status === 'authenticated');

  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameSuccess, setUsernameSuccess] = useState(false);

  // Change-password form — collapsed by default to keep the Profile section
  // visually quiet for the 99% of sessions that don't touch credentials.
  const [pwOpen,            setPwOpen]            = useState(false);
  const [pwCurrent,         setPwCurrent]         = useState('');
  const [pwNew,             setPwNew]             = useState('');
  const [pwConfirm,         setPwConfirm]         = useState('');
  const [pwError,           setPwError]           = useState('');
  const [pwSuccess,         setPwSuccess]         = useState(false);
  const [pwSaving,          setPwSaving]          = useState(false);

  // Change-email form — same collapse pattern. Submitting flips
  // emailVerified server-side and fires a fresh verification link to
  // the new address; the success banner relays that.
  const [emailOpen,        setEmailOpen]         = useState(false);
  const [emailNew,         setEmailNew]          = useState('');
  const [emailCurrent,     setEmailCurrent]      = useState('');
  const [emailError,       setEmailError]        = useState('');
  const [emailSuccess,     setEmailSuccess]      = useState('');
  const [emailSaving,      setEmailSaving]       = useState(false);

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

  // Push notifications — Web Push subscription state for THIS device.
  // 'unknown' = haven't yet looked; once we have, one of:
  //   'subscribed'   — user is opted in on this device
  //   'unsubscribed' — supported but not opted in (default for new users)
  //   'denied'       — user clicked Block in the browser prompt; only
  //                    recoverable by re-permissioning in browser settings
  //   'unsupported'  — browser doesn't ship Web Push (Safari < 16.4 non-PWA)
  //   'disabled'     — server doesn't have VAPID keys configured
  const [pushState, setPushState]   = useState('unknown');
  const [pushSaving, setPushSaving] = useState(false);
  const [pushError,  setPushError]  = useState('');

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      const perm = getNotificationPermission();
      if (perm === 'unsupported') { if (!cancelled) setPushState('unsupported'); return; }
      if (perm === 'denied')      { if (!cancelled) setPushState('denied');      return; }
      const existing = await getCurrentSubscription();
      if (cancelled) return;
      setPushState(existing ? 'subscribed' : 'unsubscribed');
    };
    init();
    return () => { cancelled = true; };
  }, []);

  const handleEnablePush = async () => {
    setPushError(''); setPushSaving(true);
    const result = await subscribeToPush();
    setPushSaving(false);
    if (result.ok) { setPushState('subscribed'); return; }
    switch (result.reason) {
      case 'permission-denied': setPushState('denied'); break;
      case 'no-vapid-key':      setPushState('disabled'); setPushError('Push notifications aren\'t configured on the server yet.'); break;
      case 'unsupported':       setPushState('unsupported'); break;
      default:                  setPushError('Couldn\'t enable notifications. Please try again.');
    }
  };

  const handleDisablePush = async () => {
    setPushError(''); setPushSaving(true);
    await unsubscribeFromPush();
    setPushSaving(false);
    setPushState('unsubscribed');
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

  const resetPwForm = () => {
    setPwOpen(false);
    setPwCurrent('');
    setPwNew('');
    setPwConfirm('');
    setPwError('');
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    setPwError('');
    setPwSuccess(false);
    if (!pwCurrent || !pwNew) { setPwError('Fill in both password fields.'); return; }
    if (pwNew !== pwConfirm)  { setPwError('New passwords do not match.');    return; }
    if (pwNew === pwCurrent)  { setPwError('New password must be different.'); return; }
    setPwSaving(true);
    try {
      await api.users.updateProfile({ password: pwNew, currentPassword: pwCurrent });
      setPwCurrent(''); setPwNew(''); setPwConfirm('');
      setPwOpen(false);
      setPwSuccess(true);
      setTimeout(() => setPwSuccess(false), 4000);
    } catch (err) {
      setPwError(err?.message ?? 'Could not update password.');
    } finally {
      setPwSaving(false);
    }
  };

  const resetEmailForm = () => {
    setEmailOpen(false);
    setEmailNew('');
    setEmailCurrent('');
    setEmailError('');
  };

  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    setEmailError('');
    setEmailSuccess('');
    const trimmed = emailNew.trim().toLowerCase();
    if (!trimmed || !emailCurrent) { setEmailError('Fill in both fields.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailError('Enter a valid email address.');
      return;
    }
    if (trimmed === (userInfo.email || '').toLowerCase()) {
      setEmailError('That\'s already your current email.');
      return;
    }
    setEmailSaving(true);
    try {
      const { user } = await api.users.updateProfile({ email: trimmed, currentPassword: emailCurrent });
      // Source-of-truth updates: userInfoSlice for downstream displays,
      // authSlice so the navbar/etc. show the new email.
      dispatch(setUserData({ ...userInfo, id: user.id, email: user.email, username: user.username }));
      dispatch(patchAuthUser({ email: user.email, emailVerified: false }));
      setEmailNew(''); setEmailCurrent('');
      setEmailOpen(false);
      setEmailSuccess(`Verification link sent to ${user.email}. Check your inbox to confirm the change.`);
    } catch (err) {
      setEmailError(err?.message ?? 'Could not update email.');
    } finally {
      setEmailSaving(false);
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

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">

      {/* Single-column layout — Top Picks + Stats lived in a 2nd column
          historically and now render on the Insights tab instead. The
          view prop above selects which sections to show. */}
      {view === 'account' && (
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

          {/* Account security — collapsed sections for email + password
              changes. Hidden behind toggles so the Profile area stays
              focused on the username form (the daily-driver edit) and
              the credential flows only appear when actively used.
              Both require re-entering the current password server-side. */}
          <div className="border-b border-gray-900/10 pb-8">
            <h2 className="text-base font-semibold leading-7 text-gray-900">Account security</h2>
            <p className="mt-1 text-sm leading-6 text-gray-600">
              Change the email or password you use to sign in.
            </p>

            {/* Current email + change-email toggle */}
            <div className="mt-6">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">Email</p>
                  <p className="text-sm text-gray-500 break-all">{userInfo.email || '—'}</p>
                </div>
                {!emailOpen && (
                  <button
                    type="button"
                    onClick={() => { setEmailOpen(true); setEmailSuccess(''); }}
                    className="text-sm font-semibold text-orange-600 hover:text-orange-700"
                  >
                    Change email
                  </button>
                )}
              </div>
              {emailSuccess && (
                <p className="mt-2 text-xs text-green-600">{emailSuccess}</p>
              )}

              {emailOpen && (
                <form onSubmit={handleEmailSubmit} className="mt-4 flex flex-col gap-3">
                  <div>
                    <label htmlFor="email-new" className="block text-sm font-medium text-gray-900 mb-1">
                      New email
                    </label>
                    <input
                      id="email-new"
                      type="email"
                      autoComplete="email"
                      value={emailNew}
                      onChange={(e) => { setEmailNew(e.target.value); setEmailError(''); }}
                      placeholder="you@example.com"
                      className="block w-full rounded-md border-0 py-2 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="email-current-pw" className="block text-sm font-medium text-gray-900 mb-1">
                      Current password
                    </label>
                    <input
                      id="email-current-pw"
                      type="password"
                      autoComplete="current-password"
                      value={emailCurrent}
                      onChange={(e) => { setEmailCurrent(e.target.value); setEmailError(''); }}
                      placeholder="••••••••"
                      className="block w-full rounded-md border-0 py-2 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
                    />
                  </div>
                  <p className="text-xs text-gray-500">
                    We&apos;ll send a verification link to the new address. You stay signed in.
                  </p>
                  {emailError && <p className="text-xs text-red-500">{emailError}</p>}
                  <div className="flex items-center gap-3">
                    <Button
                      type="submit"
                      size="sm"
                      loading={emailSaving}
                      disabled={!emailNew.trim() || !emailCurrent}
                    >
                      Update email
                    </Button>
                    <button
                      type="button"
                      onClick={resetEmailForm}
                      className="text-sm font-medium text-gray-600 hover:text-gray-800"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Password row + change-password toggle */}
            <div className="mt-8 border-t border-gray-100 pt-6">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-sm font-medium text-gray-900">Password</p>
                  <p className="text-sm text-gray-500">Last updated when you registered or reset it.</p>
                </div>
                {!pwOpen && (
                  <button
                    type="button"
                    onClick={() => { setPwOpen(true); setPwSuccess(false); }}
                    className="text-sm font-semibold text-orange-600 hover:text-orange-700"
                  >
                    Change password
                  </button>
                )}
              </div>
              {pwSuccess && (
                <p className="mt-2 text-xs text-green-600">Password updated. We sent a confirmation to your email.</p>
              )}

              {pwOpen && (
                <form onSubmit={handlePasswordSubmit} className="mt-4 flex flex-col gap-3">
                  <div>
                    <label htmlFor="pw-current" className="block text-sm font-medium text-gray-900 mb-1">
                      Current password
                    </label>
                    <input
                      id="pw-current"
                      type="password"
                      autoComplete="current-password"
                      value={pwCurrent}
                      onChange={(e) => { setPwCurrent(e.target.value); setPwError(''); }}
                      placeholder="••••••••"
                      className="block w-full rounded-md border-0 py-2 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="pw-new" className="block text-sm font-medium text-gray-900 mb-1">
                      New password
                    </label>
                    <input
                      id="pw-new"
                      type="password"
                      autoComplete="new-password"
                      value={pwNew}
                      onChange={(e) => { setPwNew(e.target.value); setPwError(''); }}
                      placeholder="••••••••"
                      className="block w-full rounded-md border-0 py-2 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      At least 8 characters, one letter and one number. Avoid common or guessable words.
                    </p>
                  </div>
                  <div>
                    <label htmlFor="pw-confirm" className="block text-sm font-medium text-gray-900 mb-1">
                      Confirm new password
                    </label>
                    <input
                      id="pw-confirm"
                      type="password"
                      autoComplete="new-password"
                      value={pwConfirm}
                      onChange={(e) => { setPwConfirm(e.target.value); setPwError(''); }}
                      placeholder="••••••••"
                      className="block w-full rounded-md border-0 py-2 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
                    />
                  </div>
                  {pwError && <p className="text-xs text-red-500">{pwError}</p>}
                  <div className="flex items-center gap-3">
                    <Button
                      type="submit"
                      size="sm"
                      loading={pwSaving}
                      disabled={!pwCurrent || !pwNew || !pwConfirm}
                    >
                      Update password
                    </Button>
                    <button
                      type="button"
                      onClick={resetPwForm}
                      className="text-sm font-medium text-gray-600 hover:text-gray-800"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {view === 'preferences' && (
        <div className="min-w-0 flex flex-col gap-8">

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
      )}

          {/* Push notifications — per-device opt-in. Browsers gate the
              permission prompt on a user gesture so we surface a
              real button instead of asking on app load. Subscription
              is scoped to this device; the user has to opt-in
              separately on a phone vs laptop. Falls back to a
              disabled state on browsers/situations that can't
              support push (Safari < 16.4 non-PWA, missing VAPID
              keys on the server). */}
          <div className="border-b border-gray-900/10 pb-8">
            <h2 className="text-base font-semibold leading-7 text-gray-900">Push notifications</h2>
            <p className="mt-1 text-sm leading-6 text-gray-600">
              Get a browser notification on this device when friends invite you to a group, a trip vote opens, or someone recommends a spot.
            </p>

            <div className="mt-4 flex items-center gap-3 flex-wrap">
              {pushState === 'subscribed' && (
                <>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">
                    ✓ Enabled on this device
                  </span>
                  <button
                    type="button"
                    onClick={handleDisablePush}
                    disabled={pushSaving}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                  >
                    {pushSaving ? 'Turning off…' : 'Turn off on this device'}
                  </button>
                </>
              )}

              {pushState === 'unsubscribed' && (
                <button
                  type="button"
                  onClick={handleEnablePush}
                  disabled={pushSaving}
                  className="rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-4 py-2 text-sm font-semibold text-white shadow-brand-sm hover:from-orange-400 hover:to-red-400 disabled:opacity-50 transition-all"
                >
                  {pushSaving ? 'Enabling…' : '🔔 Enable notifications'}
                </button>
              )}

              {pushState === 'denied' && (
                <p className="text-xs text-gray-500">
                  Browser notifications are blocked for this site. Re-enable them in your browser's site settings to opt in.
                </p>
              )}

              {pushState === 'unsupported' && (
                <p className="text-xs text-gray-500">
                  This browser doesn't support web push notifications. Try Chrome, Edge, Firefox, or Safari 16.4+ (added to home screen on iOS).
                </p>
              )}

              {pushState === 'disabled' && (
                <p className="text-xs text-gray-500">
                  Push notifications aren't configured on the server yet — check back later.
                </p>
              )}

              {pushState === 'unknown' && (
                <span className="text-xs text-gray-400">Checking notification status…</span>
              )}
            </div>

            {pushError && <p className="mt-2 text-xs text-red-500">{pushError}</p>}
          </div>


      {/* ── Danger zone ─────────────────────────────────── */}
      {/* Only shown in the Account view (this page's `view` prop) — keeps
          account deletion next to other account-management actions, away
          from the dietary/notifications/addresses settings. */}
      {isAuthenticated && view === 'account' && (
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

    </div>
  );
};

export default UserInfoPage;
