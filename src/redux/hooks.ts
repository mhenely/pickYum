import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import type { RootState, AppDispatch } from './store';

// Typed wrappers around React-Redux's hooks. Using these instead of the raw
// useDispatch/useSelector lets components dispatch thunks without the
// `dispatch(thunk() as any)` cast and gives autocompletion on selector args.
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
