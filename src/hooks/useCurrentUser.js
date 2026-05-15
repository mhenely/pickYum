import { useSelector, shallowEqual } from 'react-redux';

// useCurrentUser
// --------------
// Every reducer in `userInfoSlice` rebuilds `users[0]` (Immer drafts a fresh
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
const useCurrentUser = () => useSelector((state) => state.userInfo.users[0], shallowEqual);

export default useCurrentUser;
