const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

// In-memory GET cache, matches the pattern in lib/groupsApi.js +
// lib/api.ts. Subsequent navigations to /socials within ~1 min are
// instant. Any write clears the cache.
const CACHE = new Map();
const CACHE_TTL_MS = 60_000;

function cacheGet(path) {
  const hit = CACHE.get(path);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    CACHE.delete(path);
    return undefined;
  }
  return hit.data;
}

function cacheSet(path, data) {
  CACHE.set(path, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function req(path, init) {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET') {
    const cached = cacheGet(path);
    if (cached !== undefined) return cached;
  }

  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const data = await res.json();

  if (method === 'GET') {
    cacheSet(path, data);
  } else {
    // Writes invalidate everything (conservative — follow/unfriend/etc.
    // touch enough overlapping reads that pinpoint matching isn't worth
    // the maintenance cost for this volume).
    CACHE.clear();
  }
  return data;
}

const post   = (path, body)   => req(path, { method: 'POST',   body: body ? JSON.stringify(body) : undefined });
const patch  = (path, body)   => req(path, { method: 'PATCH',  body: JSON.stringify(body) });
const del    = (path)         => req(path, { method: 'DELETE' });

export const socialApi = {
  // Search users by username or email
  search: (q) => req(`/api/social/search?q=${encodeURIComponent(q)}`),

  // Current user's social summary (counts only)
  getMe: () => req('/api/social/me'),

  // Follows
  follow:       (userId) => post(`/api/social/follow/${userId}`),
  unfollow:     (userId) => del(`/api/social/follow/${userId}`),
  getFollowing: ()       => req('/api/social/following'),
  getFollowers: ()       => req('/api/social/followers'),

  // Friend requests
  sendRequest:    (userId)              => post(`/api/social/friend-request/${userId}`),
  respondRequest: (requestId, action)   => patch(`/api/social/friend-request/${requestId}`, { action }),
  cancelRequest:  (userId)              => del(`/api/social/friend-request/${userId}`),
  getIncoming:    ()                    => req('/api/social/friend-requests/incoming'),

  // Friends
  getFriends: () => req('/api/social/friends'),
  unfriend:   (userId) => del(`/api/social/friends/${userId}`),

  // Friends' recent picks
  getFriendRecentPicks: () => req('/api/social/friends/recent-picks'),

  // Recommendations
  getMyRecommendations:  ()                  => req('/api/social/recommendations/mine'),
  getMyRecForRestaurant: (restaurantId)      => req(`/api/social/recommendations/${restaurantId}/me`),
  getSocialRecs:         (restaurantId)      => req(`/api/social/recommendations/${restaurantId}/social`),
  recommend:             (restaurantId, tip) => post(`/api/social/recommendations/${restaurantId}`, { tip }),
  unrecommend:           (restaurantId)      => del(`/api/social/recommendations/${restaurantId}`),
};
