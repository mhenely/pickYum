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

    it('displays — when no rating is available', () => {
      renderWithProviders(
        <RatingDisplay restaurantId="1" googleRating={null} personalRating={null} compact />,
        { preloadedState: { rating: ratingState } },
      );
      expect(screen.getByText(/—/)).toBeInTheDocument();
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
  });
});
