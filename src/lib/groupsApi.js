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

  // ── Invites & members ────────────────────────────────────────
  invite:       (groupId, userId)    => post(`/api/groups/${groupId}/invite`, { userId }),
  respondInvite:(groupId, inviteId, action) =>
    patch(`/api/groups/${groupId}/invites/${inviteId}`, { action }),
  removeMember: (groupId, userId)    => del(`/api/groups/${groupId}/members/${userId}`),

  // ── Events ───────────────────────────────────────────────────
  createEvent:  (groupId, name)      => post(`/api/groups/${groupId}/events`, { name }),
  deleteEvent:  (groupId, eventId)   => del(`/api/groups/${groupId}/events/${eventId}`),

  // ── Event selections ─────────────────────────────────────────
  addSelection: (groupId, eventId, restaurantId) =>
    post(`/api/groups/${groupId}/events/${eventId}/selections`, { restaurantId }),
  removeSelection: (groupId, eventId, restaurantId) =>
    del(`/api/groups/${groupId}/events/${eventId}/selections/${restaurantId}`),

  // ── Event voting ─────────────────────────────────────────────
  startVoting:   (groupId, eventId)  => post(`/api/groups/${groupId}/events/${eventId}/start-voting`),
  cancelVoting:  (groupId, eventId)  => post(`/api/groups/${groupId}/events/${eventId}/cancel-voting`),
  setSchedule:   (groupId, eventId, votingStartsAt) =>
    patch(`/api/groups/${groupId}/events/${eventId}/schedule`, { votingStartsAt }),
  setEventDate:  (groupId, eventId, scheduledFor) =>
    patch(`/api/groups/${groupId}/events/${eventId}/date`, { scheduledFor }),
  acceptResult:  (groupId, eventId)  => post(`/api/groups/${groupId}/events/${eventId}/accept-result`),
};
