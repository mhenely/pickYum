import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import ProtectedRoute from '../../components/ProtectedRoute';
import { renderWithProviders } from '../../test/renderWithProviders';

const ProtectedContent = () => <div>Protected content</div>;
const AuthPage = () => <div>Auth page</div>;

const TestApp = () => (
  <Routes>
    <Route element={<ProtectedRoute />}>
      <Route path="/" element={<ProtectedContent />} />
    </Route>
    <Route path="/authentication" element={<AuthPage />} />
  </Routes>
);

describe('ProtectedRoute', () => {
  it('shows a loading indicator when auth status is idle', () => {
    renderWithProviders(<TestApp />, {
      preloadedState: { auth: { user: null, status: 'idle', error: null } },
    });
    // ProtectedRoute renders the skeleton placeholder while auth
    // resolves (replaced the old literal Loading… text). The pulse
    // class is the skeleton's stable structural marker.
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('shows a loading indicator when auth status is loading', () => {
    renderWithProviders(<TestApp />, {
      preloadedState: { auth: { user: null, status: 'loading', error: null } },
    });
    // ProtectedRoute renders the skeleton placeholder while auth
    // resolves (replaced the old literal Loading… text). The pulse
    // class is the skeleton's stable structural marker.
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('allows guests through when unauthenticated (guest mode)', () => {
    renderWithProviders(<TestApp />, {
      preloadedState: { auth: { user: null, status: 'unauthenticated', error: null } },
    });
    expect(screen.getByText('Protected content')).toBeInTheDocument();
    expect(screen.queryByText('Auth page')).not.toBeInTheDocument();
  });

  it('renders the protected outlet when authenticated', () => {
    renderWithProviders(<TestApp />, {
      preloadedState: {
        auth: { user: { id: 1, email: 'a@b.com', username: 'alice' }, status: 'authenticated', error: null },
      },
    });
    expect(screen.getByText('Protected content')).toBeInTheDocument();
    expect(screen.queryByText('Auth page')).not.toBeInTheDocument();
  });
});
