import { ReactNode } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';

import authReducer from '../redux/slices/authSlice';
import userInfoReducer from '../redux/slices/userInfoSlice';
import ratingReducer from '../redux/slices/ratingSlice';
import searchReducer from '../redux/slices/searchSlice';
import chooseModalReducer from '../redux/slices/chooseModalSlice';

export function makeStore(preloadedState: Record<string, unknown> = {}) {
  return configureStore({
    reducer: {
      auth: authReducer,
      userInfo: userInfoReducer,
      rating: ratingReducer,
      search: searchReducer,
      chooseModal: chooseModalReducer,
    },
    preloadedState,
    middleware: (getDefault) => getDefault({ serializableCheck: false }),
  });
}

interface ExtendedRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  preloadedState?: Record<string, unknown>;
  initialEntries?: string[];
}

export function renderWithProviders(
  ui: ReactNode,
  {
    preloadedState = {},
    initialEntries = ['/'],
    ...renderOptions
  }: ExtendedRenderOptions = {},
) {
  const store = makeStore(preloadedState);

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    </Provider>
  );

  return { store, ...render(ui, { wrapper: Wrapper, ...renderOptions }) };
}
