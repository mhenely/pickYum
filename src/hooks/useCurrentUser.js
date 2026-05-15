import { useSelector, shallowEqual } from 'react-redux';

// useCurrentUser
// --------------
// Every reducer in `userInfoSlice` rebuilds `state.user` (Immer drafts a fresh
// object whenever a child field is touched). Without `shallowEqual`, this
// hook returned a new reference on every favorite-toggle / option-add /
// review-write — and every consumer (SearchPage, HistoryPage, HelpMeChoose,
// RestaurantPage, GroupSessionPage, RestaurantDetailModal, …) re-rendered.
//
// `shallowEqual` compares own enumerable keys at one level deep. Top-level
// fields (`favorites`, `options`, `reviews`, etc.) keep their identity
// across reducers that didn't touch them, so the destructured array refs
// stay stable, downstream `useMemo`s don't invalidate, and the whole
// re-render cascade collapses. Single biggest perf win in the audit.
//
// Slice path was `state.userInfo.users[0]` before the Tier 2 #6 + #7
// flatten — the singleton-array-of-users shape that pretended multi-
// user was coming.
const useCurrentUser = () => useSelector((state) => state.userInfo.user, shallowEqual);

export default useCurrentUser;
