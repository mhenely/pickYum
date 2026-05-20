// Trip members panel: list, host actions (rescind invite, remove member),
// invite-by-username, copy invite link, import-from-group. Extracted from
// TripDetailPage so the route file isn't carrying 240+ lines of member
// management.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { pushToast } from '../../redux/slices/toastSlice';
import { api } from '../../lib/api';
import { groupsApi } from '../../lib/groupsApi';
import DietaryTagChips from '../DietaryTagChips';

export default function MembersSection({ trip, canHostAct, currentUserId, onRefresh }) {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const [username, setUsername] = useState('');
  const [inviting,    setInviting]    = useState(false);
  const [inviteError, setInviteError] = useState('');
  // Per-invite action loading state (rescind button).
  const [rescindingId, setRescindingId] = useState(null);
  // Import-from-group state. The dropdown lists every group the user is
  // a member of (host or not). Lazily loaded on first interaction.
  const [showImport,   setShowImport]   = useState(false);
  const [groups,       setGroups]       = useState([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [importingId,  setImportingId]  = useState(null);
  const [importError,  setImportError]  = useState('');
  const [generatingLink, setGeneratingLink] = useState(false);

  const handleCopyInviteLink = async () => {
    setGeneratingLink(true);
    try {
      const { token } = await api.trips.createInviteLink(trip.id);
      const url = `${window.location.origin}/trips/join/${token}`;
      // Some browsers gate clipboard.writeText behind a "secure context"
      // (HTTPS or localhost). Fall through to selectable text in the toast
      // when the API isn't available so the user can still copy manually.
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch { /* fall through */ }
      dispatch(pushToast({
        id: `trip-invite-${Date.now()}`,
        status: copied ? 'success' : 'info',
        label: copied
          ? 'Invite link copied — share it with anyone you want to add.'
          : `Invite link: ${url}`,
      }));
    } catch (err) {
      dispatch(pushToast({
        id: `trip-invite-err-${Date.now()}`,
        status: 'error',
        label: err.message ?? 'Could not generate invite link.',
      }));
    } finally {
      setGeneratingLink(false);
    }
  };

  const handleInvite = async (e) => {
    e.preventDefault();
    if (!username.trim()) return;
    setInviteError('');
    setInviting(true);
    try {
      await api.trips.inviteMember(trip.id, username.trim());
      setUsername('');
      onRefresh();
    } catch (err) {
      setInviteError(err.message ?? 'Could not send invite.');
    } finally {
      setInviting(false);
    }
  };

  const loadGroups = async () => {
    if (groupsLoaded) return;
    try {
      const { groups: list } = await groupsApi.list();
      setGroups(list ?? []);
      setGroupsLoaded(true);
    } catch (err) {
      setImportError(err.message ?? 'Could not load your groups.');
    }
  };

  const handleImport = async (groupId) => {
    setImportError('');
    setImportingId(groupId);
    try {
      await api.trips.importInvitesFromGroup(trip.id, groupId);
      setShowImport(false);
      onRefresh();
    } catch (err) {
      setImportError(err.message ?? 'Could not import invites.');
    } finally {
      setImportingId(null);
    }
  };

  const handleRescind = async (inviteId) => {
    setRescindingId(inviteId);
    try {
      await api.trips.rescindInvite(trip.id, inviteId);
      onRefresh();
    } catch { /* non-fatal */ }
    finally { setRescindingId(null); }
  };

  const handleRemove = async (userId) => {
    try {
      await api.trips.removeMember(trip.id, userId);
      // If the user removed themselves, they're no longer a member —
      // bounce back to the trips list since the detail page will 403.
      if (userId === currentUserId) navigate('/trips');
      else onRefresh();
    } catch {
      /* non-fatal; UI stays put */
    }
  };

  const pendingInvites = trip.invites ?? [];

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-gray-700 mb-3">
        Members <span className="text-gray-400 font-normal">({trip.members.length})</span>
      </h2>

      <ul className="flex flex-col gap-2 mb-3">
        {trip.members.map((m) => {
          const isMemberHost = m.userId === trip.hostId;
          const isMe         = m.userId === currentUserId;
          return (
            <li key={m.userId} className="flex items-start gap-2 flex-wrap">
              <span className="text-sm text-gray-800 truncate min-w-0 flex-1">
                {m.user.username}{isMemberHost && <span className="ml-1 text-xs text-orange-500">👑 host</span>}{isMe && <span className="ml-1 text-xs text-gray-400">(you)</span>}
                <span className="ml-2"><DietaryTagChips tags={m.user.dietaryTags} /></span>
              </span>
              {!trip.archivedAt && ((canHostAct && !isMemberHost) || (isMe && !isMemberHost)) && (
                <button
                  onClick={() => handleRemove(m.userId)}
                  className="text-xs font-medium text-red-500 hover:text-red-700"
                >
                  {isMe ? 'Leave' : 'Remove'}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {/* Pending invites — visible to host only (others have no use for
          this surface; the invitee sees their own invite in the navbar
          bell). Host can rescind anything still pending. */}
      {canHostAct && pendingInvites.length > 0 && (
        <div className="border-t border-gray-100 pt-2 mb-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
            Pending invites
          </p>
          <ul className="flex flex-col gap-1.5">
            {pendingInvites.map((inv) => (
              <li key={inv.id} className="flex items-center gap-2">
                <span className="text-sm text-gray-700 truncate flex-1">{inv.invited.username}</span>
                <button
                  onClick={() => handleRescind(inv.id)}
                  disabled={rescindingId === inv.id}
                  className="text-xs font-medium text-gray-500 hover:text-red-500 disabled:opacity-40"
                >
                  Rescind
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canHostAct && (
        <>
          <form onSubmit={handleInvite} className="flex gap-2 mb-2">
            <input
              type="text"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setInviteError(''); }}
              placeholder="Invite by username"
              className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <button
              type="submit"
              disabled={!username.trim() || inviting}
              className="rounded-md bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-400 disabled:opacity-40"
            >
              {inviting ? 'Sending…' : 'Invite'}
            </button>
          </form>
          {inviteError && <p className="text-xs text-red-500 mb-2">{inviteError}</p>}

          {/* Shareable link — alternative to username-by-username invite.
              Generates a signed token; anyone with the resulting URL
              who's signed in is auto-added as a member when they open it.
              30-day expiry on the server side; rotate JWT_SECRET to
              invalidate every outstanding link. */}
          <button
            onClick={handleCopyInviteLink}
            disabled={generatingLink}
            className="text-xs font-medium text-orange-600 hover:text-orange-800 disabled:opacity-40 mb-2"
          >
            {generatingLink ? 'Generating…' : '🔗 Copy invite link'}
          </button>

          <div className="border-t border-gray-100 pt-2">
            {!showImport ? (
              <button
                onClick={() => { setShowImport(true); loadGroups(); }}
                className="text-xs font-medium text-orange-600 hover:text-orange-800"
              >
                + Invite all members of a group
              </button>
            ) : (
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1.5">Pick a group:</p>
                {!groupsLoaded ? (
                  <p className="text-xs text-gray-400 italic">Loading your groups…</p>
                ) : groups.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">You're not in any groups yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {groups.map((g) => (
                      <li key={g.id} className="flex items-center justify-between gap-2">
                        <span className="text-sm text-gray-700 truncate">{g.name}</span>
                        <button
                          onClick={() => handleImport(g.id)}
                          disabled={importingId === g.id}
                          className="text-xs font-medium text-orange-600 hover:text-orange-800 disabled:opacity-40"
                        >
                          {importingId === g.id ? 'Inviting…' : 'Invite all'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {importError && <p className="text-xs text-red-500 mt-1">{importError}</p>}
                <button
                  onClick={() => { setShowImport(false); setImportError(''); }}
                  className="text-xs font-medium text-gray-500 hover:text-gray-700 mt-2"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
