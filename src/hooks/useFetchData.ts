// Shared fetch-on-mount-with-cancellation hook for modal-style
// components that load a single async payload tied to a few props.
//
// Why this exists: three modals (RestaurantDetailModal,
// PublicRestaurantInfoModal, ReviewsModal) all implemented the same
// shape inline:
//   - useState for data, loading, error
//   - useEffect with `let cancelled = false` cleanup
//   - then/catch/finally pipeline
//
// One small drift between them caused a real bug — ReviewsModal
// forgot the cancellation flag, so closing the modal mid-fetch and
// reopening with a different restaurant could let the stale promise
// overwrite the new one. Centralizing the pattern fixes that class
// of bug once.
//
// Usage:
//   const { data, loading, error, refetch } = useFetchData(
//     () => api.restaurants.get(restaurantId),
//     [restaurantId],
//   );
//
// The `deps` array is the cache key: when any dep changes, the
// fetcher is re-invoked. The fetcher itself doesn't need to be
// memoized (we capture its latest closure via a ref) — list only
// the variables you want changes-to-trigger-a-refetch for.
//
// Pass `{ enabled: false }` to skip the fetch entirely — useful for
// conditional fetches (e.g. "only fetch when the modal is open" or
// "skip when we already have the data from Redux").

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseFetchDataResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export interface UseFetchDataOptions {
  /**
   * When false, the fetcher is not invoked and state stays at
   * { data: null, loading: false, error: null }. Toggling back to
   * true triggers a fresh fetch.
   */
  enabled?: boolean;
}

export function useFetchData<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
  options: UseFetchDataOptions = {},
): UseFetchDataResult<T> {
  const { enabled = true } = options;

  // `tick` is the manual-refetch trigger. Bumping it adds a value
  // to the effect's deps array so the same logical fetch runs again
  // even when nothing else changed (e.g. user clicked "Retry").
  const [tick, setTick] = useState(0);

  // One state object so success / error transitions only fire one
  // re-render each, not separate ones for loading + data + error.
  const [state, setState] = useState<{
    data: T | null;
    loading: boolean;
    error: string | null;
  }>({
    data: null,
    loading: enabled,
    error: null,
  });

  // Capture the fetcher in a ref so the effect can read the latest
  // closure without listing fetcher in the deps array (callers
  // rarely memoize their fetcher, so listing it would re-fetch on
  // every render of the consuming component).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) {
      // Clear out any previous data when the consumer disables the
      // fetch. The alternative is to leave stale data visible, which
      // is rarely what the caller wants (e.g. modal closed → user
      // expects state to reset for next open).
      setState({ data: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    fetcherRef.current()
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error ? err.message : 'Failed to load data';
        setState((s) => ({ ...s, loading: false, error: msg }));
      });

    return () => {
      cancelled = true;
    };
    // We deliberately don't include `fetcher` (read via ref) or
    // `setState` (stable). `deps` carries everything the caller
    // wants us to react to. eslint can't see that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    refetch,
  };
}
