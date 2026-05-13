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
