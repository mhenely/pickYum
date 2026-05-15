import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import RatingDisplay from '../../components/RatingDisplay';
import { renderWithProviders } from '../../test/renderWithProviders';

vi.mock('../../lib/api', () => ({
  api: {
    restaurants: {
      getReviews: vi.fn().mockResolvedValue({ reviews: [], averageRating: null, communityRating: 4.0 }),
    },
  },
}));

const ratingState = { communityRatings: {}, pendingIds: [] };

describe('RatingDisplay', () => {
  describe('compact mode', () => {
    it('displays the personal rating when provided', () => {
      renderWithProviders(
        <RatingDisplay restaurantId="1" googleRating={null} personalRating={3.5} compact />,
        { preloadedState: { rating: ratingState } },
      );
      expect(screen.getByText(/3\.5/)).toBeInTheDocument();
    });

    it('displays N/A when no rating is available', () => {
      // Empty-state label was unified to N/A across all modes
      // (was previously '—' here and '…' for community-pending);
      // see RatingDisplay.jsx for the parity rationale.
      renderWithProviders(
        <RatingDisplay restaurantId="1" googleRating={null} personalRating={null} compact />,
        { preloadedState: { rating: ratingState } },
      );
      expect(screen.getByText(/N\/A/)).toBeInTheDocument();
    });

    it('shows the mode initial (P for personal)', () => {
      renderWithProviders(
        <RatingDisplay restaurantId="1" googleRating={4.0} personalRating={3.0} compact />,
        { preloadedState: { rating: ratingState } },
      );
      expect(screen.getByText('P')).toBeInTheDocument();
    });
  });

  describe('full mode', () => {
    it('renders mode buttons for Yours, Google, Community', () => {
      renderWithProviders(
        <RatingDisplay restaurantId="2" googleRating={4.1} personalRating={4.5} />,
        { preloadedState: { rating: ratingState } },
      );
      expect(screen.getByRole('button', { name: /yours/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /google/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /community/i })).toBeInTheDocument();
    });

    it('shows google rating when Google button is clicked', () => {
      renderWithProviders(
        <RatingDisplay restaurantId="2" googleRating={4.1} personalRating={3.0} />,
        { preloadedState: { rating: ratingState } },
      );
      fireEvent.click(screen.getByRole('button', { name: /google/i }));
      expect(screen.getByText('4.1')).toBeInTheDocument();
    });

    it('shows N/A when personal rating is null', () => {
      renderWithProviders(
        <RatingDisplay restaurantId="3" googleRating={null} personalRating={null} />,
        { preloadedState: { rating: ratingState } },
      );
      expect(screen.getByText('N/A')).toBeInTheDocument();
    });

    it('defaults to Google mode when no personal rating exists', () => {
      // No personal rating → initial mode is Google, so the
      // value shown is the googleRating without a click. Previously
      // defaulted to 'personal' and showed N/A on first render,
      // forcing the user to click Google to see the rating they
      // could already have seen.
      renderWithProviders(
        <RatingDisplay restaurantId="4" googleRating={4.3} personalRating={null} />,
        { preloadedState: { rating: ratingState } },
      );
      expect(screen.getByText('4.3')).toBeInTheDocument();
    });

    it('defaults to Personal mode when a personal rating exists', () => {
      renderWithProviders(
        <RatingDisplay restaurantId="5" googleRating={4.3} personalRating={4.8} />,
        { preloadedState: { rating: ratingState } },
      );
      expect(screen.getByText('4.8')).toBeInTheDocument();
    });
  });
});
