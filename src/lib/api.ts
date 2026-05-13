const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

const GET_CACHE = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 5_000;

function invalidateCache(prefix: string) {
  for (const key of GET_CACHE.keys()) {
    if (key.startsWith(prefix)) GET_CACHE.delete(key);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();

  if (method === 'GET') {
    const cached = GET_CACHE.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.data as T;
  }

  const { headers, ...rest } = init ?? {};
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...rest,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    const err = new Error(body.error ?? `HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const data = await res.json();

  if (method !== 'GET') {
    // Strip query string, then take at most 3 path segments as the invalidation prefix.
    // e.g. /api/users/me/favorites/123 → /api/users/me  (invalidates all user subresources)
    //      /api/restaurants           → /api/restaurants (invalidates just the restaurant list)
    const basePath = path.split('?')[0];
    const segments = basePath.split('/').filter(Boolean);
    const prefix = '/' + segments.slice(0, Math.min(3, segments.length)).join('/');
    invalidateCache(prefix);
  } else {
    GET_CACHE.set(path, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  return data as T;
}

export interface AuthUser {
  id: number;
  email: string;
  username: string;
  flipCount?: number;
  avatarUrl?: string | null;
}

export interface ApiRestaurant {
  id: number;
  googlePlaceId: string | null;
  name: string;
  cuisineType: string | null;
  priceLevel: number | null;
  hours: string | null;
  phone: string | null;
  website: string | null;
  yelpUrl: string | null;
  takeout: boolean;
  delivery: boolean;
  googleRating: string | null;
}

export interface ApiAccepted {
  id: number;
  restaurantId: number;
  acceptedAt: string;
  restaurant: ApiRestaurant;
}

export interface PlacesRestaurant {
  googlePlaceId: string;
  name: string;
  googleRating: number | null;
  priceLevel: number | null;
  address: string | null;
  cuisineType: string | null;
  takeout: boolean;
  delivery: boolean;
  openNow: boolean | null;
  distanceKm: number | null;
}

export interface ApiReview {
  id: number;
  restaurantId: number;
  rating: string;
  content: string | null;
  createdAt: string;
  restaurant?: ApiRestaurant;
}

export interface CommunityReview {
  id: number;
  restaurantId: number;
  rating: string;
  content: string | null;
  createdAt: string;
  user: { id: number; username: string };
}

export type ChooseMethod = 'flip' | 'spin' | 'vote' | 'surprise' | 'direct';

export interface DecisionInsights {
  totalDecisions: number;
  distinctChosen: number;
  methodCounts: Record<string, number>;
  cuisineConsidered: Record<string, number>;
  cuisineChosen: Record<string, number>;
  topConsidered: Array<{
    restaurantId: string;
    name: string;
    cuisineType: string | null;
    considered: number;
    wins: number;
    winRate: number;
  }>;
  oftenSkipped: Array<{
    restaurantId: string;
    name: string;
    cuisineType: string | null;
    considered: number;
    wins: number;
    winRate: number;
  }>;
  recent: Array<{
    restaurantId: string;
    name: string;
    acceptedAt: string;
    chooseMethod: ChooseMethod | null;
    competing: string[];
  }>;
}

export const api = {
  auth: {
    me: () =>
      request<{ user: AuthUser }>('/api/auth/me'),
    login: (body: { email: string; password: string }) =>
      request<{ user: AuthUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
    register: (body: { email: string; username: string; password: string }) =>
      request<{ user: AuthUser }>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
    logout: () =>
      request('/api/auth/logout', { method: 'POST' }),
    supabaseCallback: (access_token: string) =>
      request<{ user: AuthUser }>('/api/auth/supabase', { method: 'POST', body: JSON.stringify({ access_token }) }),
    forgotPassword: (email: string) =>
      request<{ message: string }>('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
    resetPassword: (body: { token: string; password: string }) =>
      request<{ message: string }>('/api/auth/reset-password', { method: 'POST', body: JSON.stringify(body) }),
    verifyEmail: (token: string) =>
      request<{ message: string }>('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }),
    resendVerification: () =>
      request<{ message: string }>('/api/auth/resend-verification', { method: 'POST' }),
  },
  users: {
    // Server requires `currentPassword` whenever `email` or `password` is set
    // (re-auth before sensitive change). Username-only updates don't need it.
    updateProfile: (body: { email?: string; username?: string; password?: string; currentPassword?: string }) =>
      request<{ user: AuthUser }>('/api/users/me', { method: 'PATCH', body: JSON.stringify(body) }),
    deleteAccount: () =>
      request<{ message: string }>('/api/users/me', { method: 'DELETE' }),
    getFavorites: () =>
      request<{ favorites: ApiRestaurant[] }>('/api/users/me/favorites'),
    addFavorite: (id: number) =>
      request('/api/users/me/favorites/' + id, { method: 'POST' }),
    removeFavorite: (id: number) =>
      request('/api/users/me/favorites/' + id, { method: 'DELETE' }),
    getOptions: () =>
      request<{ options: ApiRestaurant[] }>('/api/users/me/options'),
    addOption: (id: number) =>
      request('/api/users/me/options/' + id, { method: 'POST' }),
    removeOption: (id: number) =>
      request('/api/users/me/options/' + id, { method: 'DELETE' }),
    getAccepted: () =>
      request<{ accepted: ApiAccepted[] }>('/api/users/me/accepted'),
    addAccepted: (
      restaurantId: number,
      opts: { optionsSnapshot?: string[]; chooseMethod?: ChooseMethod } = {},
    ) =>
      request<{ accepted: ApiAccepted }>('/api/users/me/accepted', {
        method: 'POST',
        body: JSON.stringify({ restaurantId, ...opts }),
      }),
    getInsights: () =>
      request<DecisionInsights>('/api/users/me/insights'),
    getArchived: () =>
      request<{ archived: ApiRestaurant[] }>('/api/users/me/archived'),
    archiveRestaurant: (id: number) =>
      request('/api/users/me/archived/' + id, { method: 'POST' }),
    unarchiveRestaurant: (id: number) =>
      request('/api/users/me/archived/' + id, { method: 'DELETE' }),
    getAll: () =>
      request<{ favorites: ApiRestaurant[]; options: ApiRestaurant[]; accepted: ApiAccepted[]; archived: ApiRestaurant[]; reviews: ApiReview[] }>('/api/users/me/all'),
    getReviews: () =>
      request<{ reviews: ApiReview[] }>('/api/users/me/reviews'),
    addReview: (body: { restaurantId: number; rating: number; content?: string }) =>
      request<{ review: ApiReview }>('/api/users/me/reviews', { method: 'POST', body: JSON.stringify(body) }),
    deleteReview: (id: number) =>
      request('/api/users/me/reviews/' + id, { method: 'DELETE' }),
    refreshPlaces: () =>
      request<{ updated: ApiRestaurant[] }>('/api/users/me/refresh-places', { method: 'POST' }),
    recordFlip: () =>
      request<{ flipCount: number }>('/api/users/me/flip', { method: 'POST' }),
    removeFromHistory: (restaurantId: number) =>
      request<{ message: string }>('/api/users/me/history/' + restaurantId, { method: 'DELETE' }),
  },
  restaurants: {
    create: (body: {
      name: string;
      googlePlaceId?: string;
      cuisineType?: string;
      priceLevel?: number;
      googleRating?: number;
      hours?: string;
      phone?: string;
      website?: string;
      yelpUrl?: string;
      takeout?: boolean;
      delivery?: boolean;
    }) => request<{ restaurant: ApiRestaurant }>('/api/restaurants', { method: 'POST', body: JSON.stringify(body) }),
    // Public detail fetch — used by the voting page's info modal. Auth-optional
    // (guest voters can call it), returns only Restaurant-table fields (no
    // personal reviews, no favorites). The route is already gated this way
    // server-side via lack of requireAuth on GET /api/restaurants/:id.
    get: (id: number) =>
      request<{ restaurant: ApiRestaurant & { address?: string | null; communityRating?: string | null } }>(
        `/api/restaurants/${id}`,
      ),
    getReviews: (id: number) =>
      request<{ reviews: CommunityReview[]; averageRating: number | null; communityRating: number | null }>(
        `/api/restaurants/${id}/reviews`,
      ),
  },
  places: {
    nearby: (address: string, radiusMeters: number) =>
      request<{ restaurants: PlacesRestaurant[]; rawPlaces: unknown[]; configured: boolean; resolvedAddress?: string }>(
        `/api/places/nearby?address=${encodeURIComponent(address)}&radiusMeters=${radiusMeters}`,
      ),
    search: (q: string) =>
      request<{ restaurants: PlacesRestaurant[]; configured: boolean }>(
        `/api/places/text-search?q=${encodeURIComponent(q)}`,
      ),
  },
};
