import { useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import StarRating from './star-rating/star-rating.component';

const SORT_OPTIONS = [
  { label: 'Most Recent', value: 'date-desc' },
  { label: 'Oldest First', value: 'date-asc' },
  { label: 'Highest Rating', value: 'rating-desc' },
  { label: 'Lowest Rating', value: 'rating-asc' },
];

const RestaurantReviewModal = ({ restaurant, reviews, onClose, onAddReview, onRemoveReview, readOnly = false }) => {
  const [sortBy, setSortBy] = useState('date-desc');
  const [content, setContent] = useState('');
  const [rating, setRating] = useState(5);
  const [date, setDate] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!content.trim()) return;
    onAddReview({ content, rating, date: date || new Date().toLocaleDateString() });
    setContent('');
    setRating(5);
    setDate('');
  };

  const sortedReviews = [...reviews].sort((a, b) => {
    if (sortBy === 'date-desc') return new Date(b.date) - new Date(a.date);
    if (sortBy === 'date-asc') return new Date(a.date) - new Date(b.date);
    if (sortBy === 'rating-desc') return b.rating - a.rating;
    if (sortBy === 'rating-asc') return a.rating - b.rating;
    return 0;
  });

  return (
    <Dialog open={true} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl flex flex-col max-h-[85vh]">

          <div className="flex justify-between items-center mb-4">
            <DialogTitle className="text-lg font-semibold text-gray-900">
              {restaurant.name}
            </DialogTitle>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {/* Add Review Form */}
          {!readOnly && (
            <form onSubmit={handleSubmit} className="mb-4 pb-4 border-b border-gray-200">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Add a Review</h3>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Write your review..."
                required
                rows={2}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none"
              />
              <div className="flex flex-wrap gap-3 mt-2 items-center">
                <div className="flex items-center gap-1">
                  <label className="text-xs text-gray-500">Rating:</label>
                  <select
                    value={rating}
                    onChange={(e) => setRating(Number(e.target.value))}
                    className="text-sm rounded border border-gray-300 pl-2 pr-8 py-0.5"
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>{n} star{n !== 1 ? 's' : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-1">
                  <label className="text-xs text-gray-500">Date:</label>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="text-sm rounded border border-gray-300 px-1 py-0.5"
                  />
                </div>
                <button
                  type="submit"
                  className="ml-auto rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500"
                >
                  Submit
                </button>
              </div>
            </form>
          )}

          {/* Sort Control */}
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <span className="text-xs text-gray-500">Sort by:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="text-sm rounded border border-gray-300 pl-2 pr-8 py-1"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            {reviews.length > 0 && (
              <span className="ml-auto text-xs text-gray-400">
                {reviews.length} review{reviews.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Reviews List */}
          <div className="overflow-y-auto flex-1 -mx-1 px-1">
            {sortedReviews.length === 0 ? (
              <p className="text-sm text-gray-400 italic">
                {readOnly ? 'No reviews yet.' : 'No reviews yet. Be the first to add one above.'}
              </p>
            ) : (
              sortedReviews.map((review) => (
                <div
                  key={review.id ?? `${review.content}-${review.date}`}
                  className="mb-3 pb-3 border-b border-gray-100 last:border-0"
                >
                  <div className="flex justify-between items-center">
                    <StarRating rating={review.rating} />
                    {!readOnly && (
                      <button
                        onClick={() => onRemoveReview(review.id)}
                        className="text-xs text-gray-300 hover:text-red-400 ml-2"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <p className="text-sm text-gray-700 mt-1">{review.content}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{review.date}</p>
                </div>
              ))
            )}
          </div>

        </DialogPanel>
      </div>
    </Dialog>
  );
};

export default RestaurantReviewModal;
