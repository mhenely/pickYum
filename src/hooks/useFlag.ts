import { useSelector } from 'react-redux';
import { defaultFlags, type FeatureFlags } from '../redux/slices/flagsSlice';

// Read a single feature flag from Redux. Wraps useSelector with the
// right path so components stay terse:
//
//   const showNewModal = useFlag('newDetailModal');
//
// Defensive fallback: when the flags slice is missing from the store
// (stale dev-mode build, partial refactor) the hook returns the
// documented default. Same fail-open posture as the slice's
// loadFlags.rejected reducer. The cost of guessing wrong on a flag
// value is way smaller than the cost of whitescreening the page.
export function useFlag<K extends keyof FeatureFlags>(name: K): FeatureFlags[K] {
  return useSelector((s: { flags?: { values?: FeatureFlags } }) =>
    s.flags?.values?.[name] ?? defaultFlags[name],
  );
}
