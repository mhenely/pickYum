const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

// All session calls send credentials. Guest endpoints (join/vote) don't
// require a cookie, but if one is present the server uses it to detect
// signed-in joiners and record their auth username alongside their
// display name. CORS (`credentials: true` on the server) makes this safe.
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

const post = (path, body) =>
  req(path, { method: 'POST', body: JSON.stringify(body) });

// Kept for compatibility / readability — same as `post` now that all calls
// include credentials. Host-only endpoints still enforce auth server-side.
const authPost = post;

export const sessionApi = {
  create: ({ hostName, candidates, restaurants, voteMethod }) =>
    authPost('/api/sessions', { hostName, candidates, restaurants, voteMethod }),

  get: (id) =>
    req(`/api/sessions/${id}`),

  // /join returns `{ session, voterToken }`. The token is the voter's capability
  // to submit ballots under their display name — pass it back on /vote. If the
  // caller already has a token (e.g. after a refresh) they can supply it here
  // to re-attach to the same name; otherwise a new one is minted.
  join: (id, name, voterToken) =>
    post(`/api/sessions/${id}/join`, voterToken ? { name, voterToken } : { name }),

  start: (id) =>
    authPost(`/api/sessions/${id}/start`, {}),

  // Simple approval ballot — pass `votes` as { [candidateId]: boolean }.
  // voterToken is required for non-host voters; the host's JWT cookie satisfies
  // the auth check instead, so a null token is acceptable when voting as host.
  vote: (id, voterName, votes, voterToken) =>
    post(`/api/sessions/${id}/vote`, { voterName, votes, voterToken }),

  // Ranked-choice ballot — pass `ranking` as an ordered array of candidate IDs
  voteRanked: (id, voterName, ranking, voterToken) =>
    post(`/api/sessions/${id}/vote`, { voterName, ranking, voterToken }),

  close: (id) =>
    authPost(`/api/sessions/${id}/close`, {}),

  flip: (id, method = 'flip') =>
    authPost(`/api/sessions/${id}/flip`, { method }),

  redo: (id) =>
    authPost(`/api/sessions/${id}/redo`, {}),

  // Host: remove the current winner from candidates and retry
  reject: (id) =>
    authPost(`/api/sessions/${id}/reject`, {}),
};
