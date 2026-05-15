const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

async function req(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

const post  = (path, body) => req(path, { method: 'POST',   body: body != null ? JSON.stringify(body) : undefined });
const patch = (path, body) => req(path, { method: 'PATCH',  body: JSON.stringify(body) });
const del   = (path)       => req(path, { method: 'DELETE' });

export const groupsApi = {
  // ── Group management ─────────────────────────────────────────
  list:         ()                   => req('/api/groups'),
  create:       (name)               => post('/api/groups', { name }),
  get:          (groupId)            => req(`/api/groups/${groupId}`),
  disband:      (groupId)            => del(`/api/groups/${groupId}`),
  // Hands ownership to another member (who must already be in the group).
  // The current host is demoted to a regular member; the new host gets full
  // host privileges. Used by the "Leave group" flow when the host wants to
  // keep the group alive.
  transferHost: (groupId, newHostId) => patch(`/api/groups/${groupId}/transfer-host`, { newHostId }),

  // ── Invites & members ────────────────────────────────────────
  invite:       (groupId, userId)    => post(`/api/groups/${groupId}/invite`, { userId }),
  respondInvite:(groupId, inviteId, action) =>
    patch(`/api/groups/${groupId}/invites/${inviteId}`, { action }),
  removeMember: (groupId, userId)    => del(`/api/groups/${groupId}/members/${userId}`),

  // ── Events ───────────────────────────────────────────────────
  // optionRestaurantIds is optional — when provided, the server seeds
  // the initial options in the same transaction as the event create, so
  // callers that want "create event from N favorites" stop paying N+1
  // round-trips through the write rate limiter.
  createEvent:  (groupId, name, optionRestaurantIds) =>
    post(`/api/groups/${groupId}/events`, optionRestaurantIds && optionRestaurantIds.length > 0
      ? { name, optionRestaurantIds }
      : { name }),
  deleteEvent:  (groupId, eventId)   => del(`/api/groups/${groupId}/events/${eventId}`),

  // ── Event options ────────────────────────────────────────────
  addOption: (groupId, eventId, restaurantId) =>
    post(`/api/groups/${groupId}/events/${eventId}/options`, { restaurantId }),
  removeOption: (groupId, eventId, restaurantId) =>
    del(`/api/groups/${groupId}/events/${eventId}/options/${restaurantId}`),

  // ── Event voting ─────────────────────────────────────────────
  startVoting:   (groupId, eventId)  => post(`/api/groups/${groupId}/events/${eventId}/start-voting`),
  cancelVoting:  (groupId, eventId)  => post(`/api/groups/${groupId}/events/${eventId}/cancel-voting`),
  setSchedule:   (groupId, eventId, votingStartsAt) =>
    patch(`/api/groups/${groupId}/events/${eventId}/schedule`, { votingStartsAt }),
  setEventDate:  (groupId, eventId, scheduledFor) =>
    patch(`/api/groups/${groupId}/events/${eventId}/date`, { scheduledFor }),
  // voteMethod must be 'SIMPLE' or 'RANKED'. Locked once event status leaves OPEN.
  setVoteMethod: (groupId, eventId, voteMethod) =>
    patch(`/api/groups/${groupId}/events/${eventId}/vote-method`, { voteMethod }),
  acceptResult:  (groupId, eventId)  => post(`/api/groups/${groupId}/events/${eventId}/accept-result`),
  // Returns one event with full ballot/IRV detail — used by ballot detail modals.
  getEvent:      (groupId, eventId)  => req(`/api/groups/${groupId}/events/${eventId}`),

  // ── Group favorites ──────────────────────────────────────────
  // Shared restaurant list scoped to a group — separate from each member's
  // personal favorites. Any member can add/remove.
  listFavorites:   (groupId)               => req(`/api/groups/${groupId}/favorites`),
  addFavorite:     (groupId, restaurantId) => post(`/api/groups/${groupId}/favorites/${restaurantId}`),
  removeFavorite:  (groupId, restaurantId) => del(`/api/groups/${groupId}/favorites/${restaurantId}`),

  // ── Group insights ───────────────────────────────────────────
  // Aggregate analytics over the group's completed events. Same shape family
  // as /api/users/me/insights but scoped to one group's history.
  getInsights:     (groupId) => req(`/api/groups/${groupId}/insights`),
};
