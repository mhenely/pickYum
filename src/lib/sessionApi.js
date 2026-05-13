const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

async function req(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// Unauthenticated post (guests/participants)
const post = (path, body) =>
  req(path, { method: 'POST', body: JSON.stringify(body) });

// Authenticated post (host-only operations — sends JWT cookie)
const authPost = (path, body) =>
  req(path, { method: 'POST', credentials: 'include', body: JSON.stringify(body) });

export const sessionApi = {
  create: ({ hostName, candidates, restaurants }) =>
    authPost('/api/sessions', { hostName, candidates, restaurants }),

  get: (id) =>
    req(`/api/sessions/${id}`),

  join: (id, name) =>
    post(`/api/sessions/${id}/join`, { name }),

  start: (id) =>
    authPost(`/api/sessions/${id}/start`, {}),

  vote: (id, voterName, votes) =>
    post(`/api/sessions/${id}/vote`, { voterName, votes }),

  close: (id) =>
    authPost(`/api/sessions/${id}/close`, {}),

  flip: (id, method = 'flip') =>
    authPost(`/api/sessions/${id}/flip`, { method }),

  redo: (id) =>
    authPost(`/api/sessions/${id}/redo`, {}),
};
